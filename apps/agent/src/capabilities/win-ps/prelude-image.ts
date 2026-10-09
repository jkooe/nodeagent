/**
 * 图像模板匹配预加载段（ZNCC 粗到精）
 *
 * 2026-10 从 window.ts 抽出（结构拆分，**内容逐字节不变**）。
 * ⚠️ WIN_HELPER_PRELUDE 是本段与另外几段的拼接 —— 改动会直接影响常驻 PS 助手。
 * 拆分以 tests/unit/win-prelude.test.mjs + prelude sha256 比对双重把关。
 */

/**
 * 图像模板匹配预加载段（v15）。
 *
 * 动机：UIA 靠控件树、OCR 靠文字 —— **纯图标/无文字的控件**两者都抓不到（审查报告 §5.2 指出的盲区）。
 * 做法：把模板图与屏幕区域都转灰度，做**零均值归一化互相关（ZNCC）**；
 * 全分辨率逐像素太慢（3440×1440 屏 × 64×64 模板 ≈ 190 亿次），故**粗到精**：
 *   ① 1/4 分辨率全图扫描（约 8000 万次）取候选
 *   ② 对候选在全分辨率 ±10px 邻域精修
 * 编译一次常驻（随助手预加载），运行时纯 native 循环。
 * 亮度和对比度无关（ZNCC 归一化），故对主题/亮度变化不敏感。
 */
export const IMAGE_MATCH_PRELUDE = `
Add-Type -AssemblyName System.Drawing
# ⚠️ Add-Type 的老坑：-AssemblyName 只把程序集加载进 PowerShell 会话，
#    编译 C# 时还必须显式 -ReferencedAssemblies，否则报「命名空间 System.Drawing
#    中不存在 Imaging」。真机踩过：编译失败会让整个助手起不来，并伴随误导性的
#    「找不到类型 System.Windows.Forms.SystemInformation」二次错误。
Add-Type @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class NAImageMatch {
  public class Hit { public int x; public int y; public int w; public int h; public double score; }

  private static byte[] Gray(Bitmap src, out int w, out int h) {
    w = src.Width; h = src.Height;
    var dst = new byte[w * h];
    var rect = new Rectangle(0, 0, w, h);
    Bitmap bmp = src.PixelFormat == PixelFormat.Format24bppRgb ? src : src.Clone(rect, PixelFormat.Format24bppRgb);
    var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    try {
      int stride = data.Stride;
      var buf = new byte[stride * h];
      Marshal.Copy(data.Scan0, buf, 0, buf.Length);
      for (int y = 0; y < h; y++) {
        int row = y * stride;
        for (int x = 0; x < w; x++) {
          int i = row + x * 3;
          // BGR -> luma (integer approximation of ITU-R BT.601)
          dst[y * w + x] = (byte)((buf[i + 2] * 77 + buf[i + 1] * 150 + buf[i] * 29) >> 8);
        }
      }
    } finally { bmp.UnlockBits(data); if (bmp != src) bmp.Dispose(); }
    return dst;
  }

  // Area-average downscale (coarse search layer)
  private static byte[] Downscale(byte[] src, int w, int h, int f, out int ow, out int oh) {
    ow = w / f; oh = h / f;
    var dst = new byte[ow * oh];
    for (int y = 0; y < oh; y++) {
      for (int x = 0; x < ow; x++) {
        int sum = 0;
        for (int dy = 0; dy < f; dy++) {
          int row = (y * f + dy) * w;
          for (int dx = 0; dx < f; dx++) sum += src[row + x * f + dx];
        }
        dst[y * ow + x] = (byte)(sum / (f * f));
      }
    }
    return dst;
  }

  // Zero-mean normalized cross correlation; 1.0 = identical
  private static double Zncc(byte[] S, int sw, int sx, int sy, byte[] T, int tw, int th) {
    int n = tw * th;
    double sumT = 0;
    for (int i = 0; i < n; i++) sumT += T[i];
    double meanT = sumT / n;

    double sumS = 0;
    for (int y = 0; y < th; y++) {
      int row = (sy + y) * sw + sx;
      for (int x = 0; x < tw; x++) sumS += S[row + x];
    }
    double meanS = sumS / n;

    double num = 0, dS = 0, dT = 0;
    for (int y = 0; y < th; y++) {
      int row = (sy + y) * sw + sx;
      int trow = y * tw;
      for (int x = 0; x < tw; x++) {
        double a = S[row + x] - meanS;
        double b = T[trow + x] - meanT;
        num += a * b; dS += a * a; dT += b * b;
      }
    }
    double den = Math.Sqrt(dS * dT);
    if (den < 1e-9) return 0;
    return num / den;
  }

  /**
   // (comment removed: ASCII only)
   // (comment removed: ASCII only)
   */
  public static string Match(string screenPath, string templatePath, int maxResults, double threshold, int searchX, int searchY, int searchW, int searchH) {
    var hits = new List<Hit>();
    using (var screenBmp = new Bitmap(screenPath))
    using (var tmplBmp = new Bitmap(templatePath)) {
      int sw, sh, tw, th;
      var S0 = Gray(screenBmp, out sw, out sh);
      var T0 = Gray(tmplBmp, out tw, out th);
      if (tw >= sw || th >= sh) return "[]";

      // Guard: a flat template carries no gradient information, so correlation is
      // undefined (ZNCC denominator ~ 0). Report it explicitly instead of silently
      // returning no hits - a uniform crop usually means the wrong region was picked.
      //
      // NOTE: build all JSON/string literals with the char constant Q.
      // Writing a backslash-quote inside a TS template literal collapses it to a bare
      // quote and breaks the C# compile - this trap bit this file twice.
      const char Q = '"';
      var ci0 = System.Globalization.CultureInfo.InvariantCulture;
      double tSum = 0, tSum2 = 0;
      for (int i = 0; i < T0.Length; i++) { tSum += T0[i]; tSum2 += (double)T0[i] * T0[i]; }
      double tMean = tSum / T0.Length;
      double tVar = (tSum2 / T0.Length) - (tMean * tMean);
      if (tVar < 4.0) {
        return "[" + "{" + Q + "__error" + Q + ":" + Q + "template_has_no_contrast" + Q
          + "," + Q + "variance" + Q + ":" + tVar.ToString("F2", ci0) + "}" + "]";
      }

      // Optional search window: crop a sub-image, then add the offset back to hit coords
      int ox = 0, oy = 0;
      if (searchW > 0 && searchH > 0) {
        ox = Math.Max(0, Math.Min(searchX, sw - 1));
        oy = Math.Max(0, Math.Min(searchY, sh - 1));
        int w = Math.Min(searchW, sw - ox), h = Math.Min(searchH, sh - oy);
        var sub = new byte[w * h];
        for (int y = 0; y < h; y++) Array.Copy(S0, (oy + y) * sw + ox, sub, y * w, w);
        S0 = sub; sw = w; sh = h;
      }

      const int F = 4;
      int sw4, sh4, tw4, th4;
      var S4 = Downscale(S0, sw, sh, F, out sw4, out sh4);
      var T4 = Downscale(T0, tw, th, F, out tw4, out th4);

      // (1) coarse scan: collect candidates.
      // NOTE: the pre-filter must be MUCH looser than the final threshold.
      // Downsampling lowers the correlation of the true position (typically 0.7-0.85
      // for a 0.9+ full-res match), so a tight pre-filter discards the right answer
      // before refinement ever runs (this exact bug made every match return empty).
      var cands = new List<Hit>();
      if (tw4 > 0 && th4 > 0 && tw4 <= sw4 && th4 <= sh4) {
        double preFilter = Math.Max(0.30, threshold - 0.30);
        double bestCoarse = -1; int bx4 = 0, by4 = 0;
        for (int y = 0; y <= sh4 - th4; y++) {
          for (int x = 0; x <= sw4 - tw4; x++) {
            double sc = Zncc(S4, sw4, x, y, T4, tw4, th4);
            if (sc > bestCoarse) { bestCoarse = sc; bx4 = x; by4 = y; }
            if (sc >= preFilter) cands.Add(new Hit { x = x * F, y = y * F, w = tw, h = th, score = sc });
          }
        }
        // Belt and braces: always keep the coarse best, even if it missed the pre-filter
        if (bestCoarse > 0) {
          bool seen = false;
          foreach (var c in cands) { if (Math.Abs(c.x - bx4 * F) < F && Math.Abs(c.y - by4 * F) < F) { seen = true; break; } }
          if (!seen) cands.Add(new Hit { x = bx4 * F, y = by4 * F, w = tw, h = th, score = bestCoarse });
        }
      }
      cands.Sort((a, b) => b.score.CompareTo(a.score));
      if (cands.Count > 40) cands.RemoveRange(40, cands.Count - 40);

      // (2) refine at full resolution within a +/-F*2 neighborhood
      foreach (var c in cands) {
        double best = -1; int bx = c.x, by = c.y;
        for (int dy = -F * 2; dy <= F * 2; dy++) {
          for (int dx = -F * 2; dx <= F * 2; dx++) {
            int x = c.x + dx, y = c.y + dy;
            if (x < 0 || y < 0 || x + tw > sw || y + th > sh) continue;
            double sc = Zncc(S0, sw, x, y, T0, tw, th);
            if (sc > best) { best = sc; bx = x; by = y; }
          }
        }
        if (best >= threshold) hits.Add(new Hit { x = bx + ox, y = by + oy, w = tw, h = th, score = best });
      }

      // (3) de-dup: non-maximum suppression (keep best within 8px)
      hits.Sort((a, b) => b.score.CompareTo(a.score));
      var final = new List<Hit>();
      foreach (var h in hits) {
        bool dup = false;
        foreach (var f in final) {
          if (Math.Abs(f.x - h.x) < 8 && Math.Abs(f.y - h.y) < 8) { dup = true; break; }
        }
        if (!dup) final.Add(h);
        if (final.Count >= maxResults) break;
      }

      var parts = new List<string>();
      foreach (var h in final) {
        // Build JSON by concatenation; reuse the shared Q / ci0 declared above.
        var ci = ci0;
        parts.Add("{" + Q + "x" + Q + ":" + h.x.ToString(ci) + "," + Q + "y" + Q + ":" + h.y.ToString(ci)
          + "," + Q + "width" + Q + ":" + h.w.ToString(ci) + "," + Q + "height" + Q + ":" + h.h.ToString(ci)
          + "," + Q + "score" + Q + ":" + h.score.ToString("F4", ci) + "}");
      }
      return "[" + String.Join(",", parts.ToArray()) + "]";
    }
  }

  // Capture a screen region to a file (avoids extra process round-trips)
  public static string Capture(string outPath, int x, int y, int w, int h) {
    using (var bmp = new Bitmap(w, h))
    using (var g = Graphics.FromImage(bmp)) {
      g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
      bmp.Save(outPath, ImageFormat.Png);
    }
    return outPath;
  }
}
"@ -ReferencedAssemblies System.Drawing
`;
