import type { CapabilityDescriptor } from '../../messages.js';
import { CapabilityNames } from '../names.js';
import { filterSchema } from '../schemas.js';

/** graphics 组能力清单 */
export const GRAPHICS_CAPABILITIES: CapabilityDescriptor[] = [
  {
    name: CapabilityNames.ScreenInfo,
    version: '1.0',
    description: '获取显示器信息（分辨率、缩放、主屏标识）',
    risk: 'low',
    params_schema: { type: 'object', properties: {}, additionalProperties: false },
    returns_schema: {
      type: 'object',
      properties: {
        displays: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              is_primary: { type: 'boolean' },
              scale: { type: 'number' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.ScreenCapture,
    version: '1.0',
    description: '截取屏幕，返回 base64 图片（支持区域与缩放）',
    risk: 'medium',
    params_schema: {
      type: 'object',
      properties: {
        display_id: { type: 'integer', default: 0, minimum: 0, description: '0 = 主屏' },
        format: { type: 'string', enum: ['png', 'jpeg'], default: 'jpeg' },
        quality: { type: 'integer', default: 85, minimum: 1, maximum: 100, description: '仅 jpeg 生效' },
        scale: { type: 'number', default: 1, minimum: 0.1, maximum: 1 },
        region: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'base64 编码的图片' },
        format: { type: 'string' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        bytes: { type: 'integer' },
        captured_at: { type: 'integer' },
      },
    },
  },
  {
    name: CapabilityNames.MouseMove,
    version: '1.0',
    description: '移动鼠标到指定屏幕坐标',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
        duration_ms: { type: 'integer', default: 0, minimum: 0, maximum: 5000, description: '平滑移动耗时' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: { moved: { type: 'boolean' }, x: { type: 'integer' }, y: { type: 'integer' } },
    },
  },
  {
    name: CapabilityNames.MouseClick,
    version: '1.0',
    description: '鼠标点击（可选先移动到指定坐标）',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        count: { type: 'integer', default: 1, minimum: 1, maximum: 3 },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        clicked: { type: 'boolean' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        button: { type: 'string' },
      },
    },
  },
  {
    name: CapabilityNames.MouseScroll,
    version: '1.0',
    description: '滚动鼠标滚轮（正数向上、负数向下）',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        delta: { type: 'integer', description: '滚动格数' },
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
      },
      required: ['delta'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: { scrolled: { type: 'boolean' }, delta: { type: 'integer' } },
    },
  },
  {
    name: CapabilityNames.MouseDrag,
    version: '1.0',
    description:
      '鼠标拖拽：从 (from_x,from_y) 按下并拖到 (to_x,to_y) 释放。' +
      '用于拖动文件/窗口、框选文本、滑动条。整段动作在单次调用内完成，步数按距离自适应。',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        from_x: { type: 'integer' },
        from_y: { type: 'integer' },
        to_x: { type: 'integer' },
        to_y: { type: 'integer' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        steps: { type: 'integer', minimum: 1, maximum: 200, description: '插值步数（默认按距离自适应）' },
        step_delay_ms: { type: 'integer', minimum: 0, maximum: 200, default: 12 },
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        dragged: { type: 'boolean' },
        from: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } } },
        to: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } } },
        button: { type: 'string' },
        steps: { type: 'integer' },
      },
    },
  },
  {
    name: CapabilityNames.KeyType,
    version: '1.0',
    description: '输入一段文本（逐字符模拟键盘）',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 4096 },
        interval_ms: { type: 'integer', default: 10, minimum: 0, maximum: 1000 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: { typed: { type: 'boolean' }, length: { type: 'integer' } },
    },
  },
  {
    name: CapabilityNames.KeyPress,
    version: '1.5',
    description:
      '按下**快捷键**（v1.5 大幅扩展范围）。支持的输入形式（**一次只用一种**）：' +
      '① 字符串热键 hotkey: "ctrl+shift+esc"（配 repeat 可连按）；② 热键序列 hotkeys: ["ctrl+c","ctrl+v"]；' +
      '③ 预设别名 preset: "copy" / presets: ["copy","paste"]（约 50 个语义名，免记键位）；' +
      '④ 老数组形式 keys: ["ctrl","c"]（配 repeat）；⑤ 序列 sequence: [["up"],["enter"]]。' +
      '**按键覆盖**：字母/数字、F1-F24、左右侧修饰键（lctrl/rctrl/…）、小键盘（numpad0-9 与四则运算，' +
      '与数字键分开）、OEM 符号键（oem_plus/oem_comma/oem_period… → 支持 win+d、ctrl++、win+. 这类组合）、' +
      '媒体键、浏览器键、IME 键（kana/convert/…）、系统键（sleep/help/…）。' +
      '**长按**：hold_ms（按下到释放的保持时长，≤5s）。' +
      '**投放路由**：route=foreground（默认，SendInput 注入当前焦点）；' +
      'route=post（向 target_pid 指定进程的**全部顶层窗口** PostMessage —— 目标在后台/被遮挡时可用，' +
      '⚠️ 但游戏与部分输入型程序不响应后台键盘消息）。' +
      '**媒体键**：整条序列都是媒体键时自动改走 WM_APPCOMMAND（可定向 target_pid、不受遮挡影响）。' +
      '音量键（volume_mute/up/down）仍走虚拟键 0xAD-0xAF，由系统自行映射。',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        hotkey: {
          type: 'string',
          maxLength: 64,
          description: '单条热键字符串，如 "ctrl+shift+esc"、"win+d"、"alt+tab"；分隔符支持 + - 空格',
        },
        hotkeys: {
          type: 'array',
          items: { type: 'string', maxLength: 64 },
          minItems: 1,
          maxItems: 50,
          description: '热键字符串序列，如 ["ctrl+c","ctrl+v"]（按键序列）',
        },
        preset: { type: 'string', description: '预设语义名（单个），如 copy / show_desktop / volume_mute_toggle' },
        presets: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 50,
          description: '多个预设名 = 序列',
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 4,
          description: '（老形式）和弦按键列表，如 ["ctrl","shift","esc"]',
        },
        repeat: { type: 'integer', minimum: 1, maximum: 50, default: 1, description: '和弦/热键重复次数' },
        sequence: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
          description: '（老形式）和弦序列，如 [["up"],["up"],["enter"]]',
        },
        hold_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 5000,
          default: 0,
          description: 'v1.5 长按：按下后保持该毫秒数再释放（如长按音量键）',
        },
        route: {
          type: 'string',
          enum: ['foreground', 'post'],
          default: 'foreground',
          description:
            'v1.5 投放路由：foreground = SendInput 注入当前焦点（默认，需目标可见）；' +
            'post = 向 target_pid 进程全部顶层窗口 PostMessage（目标在后台时可用）',
        },
        target_pid: {
          type: 'integer',
          minimum: 0,
          description:
            '目标进程 PID。媒体键：0 或省略 = 广播给所有顶层窗口（播放器常建 30+ 辅助窗口，' +
            '指定 PID 会投给该进程全部顶层窗口）。route=post：必填（≥1）。',
        },
        interval_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 2000,
          default: 40,
          description: '序列中相邻和弦之间的间隔',
        },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        pressed: { type: 'boolean' },
        keys: { type: 'array', items: { type: 'string' } },
        chords: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        times: { type: 'integer' },
        presets: { type: 'array', items: { type: 'string' } },
        via: { type: 'string', description: '输入形式来源：hotkey/hotkeys/preset/presets/keys/sequence' },
        channel: { type: 'string', description: '实际投递通道：sendinput / appcommand / postmessage' },
        route: { type: 'string' },
        hold_ms: { type: 'integer' },
        target_pid: { type: 'integer' },
        sent_windows: { type: 'integer', description: 'route=post 时投递成功的窗口数' },
        note: { type: 'string' },
      },
    },
  },
  {
    name: CapabilityNames.WindowList,
    version: '1.0',
    description:
      '列出当前可见的顶层窗口（标题、所属进程、精确矩形、是否前台窗口）。Windows 用 Win32，macOS 用 AppleScript（需辅助功能权限）。' +
      '配合 screen.capture 可在**已知窗口范围内**相对定位，避免全屏猜坐标。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        title_pattern: { type: 'string', description: '可选：按标题正则过滤' },
        limit: { type: 'integer', default: 50 },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        windows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              hwnd: { type: 'string', description: '窗口句柄（十六进制）' },
              title: { type: 'string' },
              process: { type: 'string' },
              pid: { type: 'integer' },
              x: { type: 'integer' },
              y: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              is_foreground: { type: 'boolean' },
              is_minimized: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.WindowFocus,
    version: '1.0',
    description:
      '将指定窗口（按标题正则或句柄）置前并聚焦，返回其精确矩形。' +
      '⚠️ 边界：**无法越过全屏独占应用**（游戏、演示全屏）。此时会返回 focused:true，' +
      '但目标窗口在**视觉上仍被遮挡**、鼠标点击也点不到它 —— 属预期行为而非失败。' +
      '此时请改用与可见性无关的通道：input.key.press 的媒体键（走 WM_APPCOMMAND）、' +
      'system.shell.exec，或让用户手动切出全屏。',
    risk: 'medium',
    params_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '窗口标题（正则，匹配第一个）' },
        hwnd: { type: 'string', description: '或直接给窗口句柄' },
        wait_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 30000,
          default: 0,
          description: '等待窗口出现（应用启动有延迟时用；仅 title 模式有效）',
        },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        hwnd: { type: 'string' },
        title: { type: 'string' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        focused: { type: 'boolean' },
        activated_by: { type: 'string', description: '激活方式：api（SetForegroundWindow）| click（标题栏点击兜底）' },
      },
    },
  },
  {
    name: CapabilityNames.ScreenFind,
    version: '1.1',
    description:
      '在界面中查找 UI 元素并返回其**屏幕坐标**。Windows：UIA 优先，找不到自动降级 OCR（截图识别，支持自绘 UI）。' +
      'macOS：统一走 Vision OCR（无 UIA 等价物）。返回中心点坐标，直接喂给 input.mouse.click。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要查找的文本（匹配元素 Name，支持子串）' },
        window: { type: 'string', description: '可选：限定在该窗口标题（正则）内查找' },
        control_type: {
          type: 'string',
          description: '可选：限定控件类型，如 Button / MenuItem / Edit / Text / ListItem（仅 UIA）',
        },
        method: {
          type: 'string',
          enum: ['auto', 'uia', 'ocr', 'image'],
          default: 'auto',
          description:
            'auto=UIA 优先+OCR 兜底；uia=仅控件树；ocr=仅文字识别；image=仅图像模板匹配（需 template）',
        },
        where: {
          type: 'object',
          description:
            'v1.7 属性谓词（**仅 UIA 引擎生效**）：{ enabled?, selected?, value?, toggle? }。' +
            '例：{"enabled":true} 只回可用控件；{"value":"*已完成*"} 按值模糊匹配。' +
            '拿不到的属性（Electron/游戏 UI 常见）不参与命中，由调用方按 note 判断；' +
            'OCR / image 引擎无属性可读，此时忽略本参数并带回 note。',
        },
        template: {
          type: 'string',
          description:
            'method=image 时必填：被控端上的模板图片路径（png/jpg/bmp）。' +
            '用于纯图标/无文字控件 —— UIA 无控件树、OCR 无文字可读的场景',
        },
        threshold: {
          type: 'number',
          minimum: 0.3,
          maximum: 0.999,
          default: 0.85,
          description: 'method=image 的匹配阈值（零均值归一化互相关，越高越严格）',
        },
        limit: { type: 'integer', default: 20 },
        wait_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 30000,
          default: 0,
          description: '等待元素出现的上限毫秒（0=只查一次）。界面有动画/加载时用',
        },
        interval_ms: { type: 'integer', minimum: 100, maximum: 2000, default: 400 },
        region: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
          },
          description: '可选：只在该屏幕区域查找（OCR/图像匹配更快更准；UIA 忽略此参数）',
        },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        engine: { type: 'string', description: '实际使用的引擎：uia | ocr' },
        note: { type: 'string', description: 'v1.7：where 在非 UIA 引擎下被忽略等降级说明' },
        waited_ms: { type: 'integer', description: '实际等待时长（便于诊断是否命中等待窗口）' },
        matches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              control_type: { type: 'string' },
              automation_id: { type: 'string' },
              x: { type: 'integer', description: '中心点 X（屏幕坐标）' },
              y: { type: 'integer', description: '中心点 Y（屏幕坐标）' },
              left: { type: 'integer' },
              top: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              window_title: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.ScreenRecord,
    version: '1.0',
    description:
      '录制屏幕为帧序列（JPEG），检测到 ffmpeg 时额外封装 mp4。产物留在被控端目录，' +
      '用 fs.read / pull 取回。用于复现「间歇性」问题、记录 GUI 操作过程。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        duration_ms: { type: 'integer', minimum: 1000, maximum: 60000, default: 5000 },
        fps: { type: 'integer', minimum: 1, maximum: 10, default: 2 },
        scale: { type: 'number', minimum: 0.1, maximum: 1, default: 0.5, description: '全屏录制时的缩放' },
        region: {
          type: 'object',
          properties: {
            x: { type: 'integer' }, y: { type: 'integer' },
            width: { type: 'integer' }, height: { type: 'integer' },
          },
          description: '可选：只录制该区域（多屏时用负坐标）',
        },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '帧序列目录（被控端路径）' },
        frames: { type: 'integer' },
        requested_frames: { type: 'integer' },
        elapsed_ms: { type: 'integer' },
        fps: { type: 'integer' },
        video_path: { type: 'string', description: '有 ffmpeg 时的 mp4 路径' },
        frames_only: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
  },
  {
    name: CapabilityNames.GuiAwait,
    version: '1.0',
    description:
      '等待一个条件成立再返回（v1.6，**只读低危**）。四类条件：' +
      'window=等窗口出现/消失；control=等界面元素出现/消失（复用 screen.find）；' +
      'process=等进程出现/消失；file=等文件出现/消失。' +
      '用途：把 GUI 操作从「按一下→睡几秒→截图碰运气」变成**可断言**的流程，例如：' +
      'await control(text:"完成", timeout_ms:30000) → mouse.click(found.x, found.y) → await state:absent(text:"安装中")。' +
      'state=present（默认）等到出现，absent 等到消失。' +
      '四个条件各自复用 window.list / screen.find / process.list / fs.stat，' +
      '平台行为（Windows UIA/OCR、macOS Vision OCR）与那些能力完全一致。' +
      '轮询期单次异常不视为失败（启动中的程序常短暂报错），只在超时未命中时带回 last_error。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        condition: {
          type: 'string',
          enum: ['window', 'control', 'process', 'file'],
          description: '等待哪类条件',
        },
        state: {
          type: 'string',
          enum: ['present', 'absent'],
          default: 'present',
          description: '等到出现（默认）还是等到消失',
        },
        timeout_ms: { type: 'integer', minimum: 0, maximum: 60000, default: 5000, description: '总超时' },
        interval_ms: { type: 'integer', minimum: 50, maximum: 5000, default: 400, description: '轮询间隔' },
        title: { type: 'string', description: 'window 条件：窗口标题（正则）' },
        pattern: { type: 'string', description: 'window 条件的 title 别名' },
        text: { type: 'string', description: 'control 条件：元素文本（有 where 时可省）' },
        where: {
          type: 'object',
          description: 'v1.7 属性谓词（仅 UIA）：{ enabled?, selected?, value?, toggle? }，如等一个可用的按钮',
        },
        window: { type: 'string', description: 'control 条件：限定窗口标题（正则）' },
        control_type: { type: 'string', description: 'control 条件：限定控件类型（仅 UIA）' },
        method: { type: 'string', enum: ['auto', 'uia', 'ocr', 'image'], description: 'control 条件：查找方式' },
        template: { type: 'string', description: 'control 条件 + method=image 时的模板' },
        process: { type: 'string', description: 'process 条件：进程名（正则）' },
        path: { type: 'string', description: 'file 条件：文件路径' },
        limit: { type: 'integer', description: '底层 list 类条件的返回条数' },
        any_of: {
          type: 'array',
          maxItems: 8,
          description:
            'v1.7 组合条件：数组，每项为一个条件对象（同顶层参数名），**任一命中**即算命中。' +
            '例：[{"condition":"window","title":"安装完成"},{"condition":"control","text":"错误"}]' +
            '——「安装成功或报错，先出现的那个算」。与 where 合用可表达' +
            '「弹窗出现且其中某按钮 enabled」（用两条 await 亦可，任选）。',
        },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        satisfied: { type: 'boolean' },
        condition: { type: 'string' },
        state: { type: 'string' },
        elapsed_ms: { type: 'integer' },
        attempts: { type: 'integer', description: '实际轮询次数' },
        last_seen: { type: 'string' },
        last_error: { type: 'string', description: '超时未命中时带回的末次异常（若有）' },
        note: { type: 'string' },
      },
    },
  },
];
