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
    version: '1.1',
    description:
      '按下按键。keys=["ctrl","c"] 表示和弦；配 repeat=3 可连按 3 次；' +
      'sequence=[["ctrl","c"],["ctrl","v"]] 表示按键序列',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 4,
          description: '和弦按键列表，如 ["ctrl","shift","esc"]',
        },
        repeat: { type: 'integer', minimum: 1, maximum: 50, default: 1, description: '和弦重复次数' },
        sequence: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
          description: '和弦序列，如 [["up"],["up"],["enter"]]；提供时忽略 keys/repeat',
        },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: { pressed: { type: 'boolean' }, keys: { type: 'array', items: { type: 'string' } } },
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
    description: '将指定窗口（按标题正则或句柄）置前并聚焦，返回其精确矩形。',
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
];
