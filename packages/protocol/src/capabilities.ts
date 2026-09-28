import type { CapabilityDescriptor, JsonSchema } from './messages.js';

/** nodeagent v1 标准能力名。 */
export const CapabilityNames = {
  SystemInfo: 'system.info',
  SystemStatus: 'system.status',
  ProcessList: 'system.process.list',
  ServiceList: 'system.service.list',
  ShellExec: 'system.shell.exec',
  AppList: 'app.list',
  AppInstall: 'app.install',
  // v2 图形接管
  ScreenInfo: 'screen.info',
  ScreenCapture: 'screen.capture',
  MouseMove: 'input.mouse.move',
  MouseClick: 'input.mouse.click',
  MouseScroll: 'input.mouse.scroll',
  KeyType: 'input.key.type',
  KeyPress: 'input.key.press',
  // v3+ 审计
  AuditList: 'system.audit.list',
  // v5 文件传输
  FsList: 'fs.list',
  FsStat: 'fs.stat',
  FsRead: 'fs.read',
  FsWrite: 'fs.write',
  // v7 自持能力（受控重启）
  AgentRestart: 'system.agent.restart',
  // v8 GUI 语义（窗口与元素定位）
  WindowList: 'window.list',
  WindowFocus: 'window.focus',
  ScreenFind: 'screen.find',
  // v10 异步任务与剪贴板
  TaskList: 'system.task.list',
  TaskGet: 'system.task.get',
  TaskKill: 'system.task.kill',
  ClipGet: 'clip.get',
  ClipSet: 'clip.set',
} as const;

export type CapabilityName = (typeof CapabilityNames)[keyof typeof CapabilityNames];

// ---------- 通用 schema 片段 ----------

const filterSchema: JsonSchema = {
  type: 'object',
  properties: {
    name_pattern: { type: 'string', description: '名称匹配（子串，不区分大小写）' },
  },
  additionalProperties: false,
};

// ---------- 能力清单 ----------

/**
 * v1 标准能力清单。
 * 被控端按此声明并在 auth_ok 中返回；控制端据此展示与校验。
 */
export const CAPABILITY_MANIFEST: CapabilityDescriptor[] = [
  {
    name: CapabilityNames.SystemInfo,
    version: '1.0',
    description: '获取 Windows 系统基本信息（主机名、OS、CPU、内存、开机时长）',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: '可选：只返回指定字段',
          items: { type: 'string' },
        },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        hostname: { type: 'string' },
        os: { type: 'string' },
        os_version: { type: 'string' },
        arch: { type: 'string' },
        cpu_model: { type: 'string' },
        cpu_cores: { type: 'integer' },
        memory_total: { type: 'integer', description: '字节' },
        uptime_sec: { type: 'integer' },
        is_admin: { type: 'boolean' },
      },
    },
  },
  {
    name: CapabilityNames.SystemStatus,
    version: '1.0',
    description: '获取资源状态：CPU 占用、内存、磁盘、网络适配器',
    risk: 'low',
    params_schema: { type: 'object', properties: {}, additionalProperties: false },
    returns_schema: {
      type: 'object',
      properties: {
        cpu_pct: { type: 'number' },
        memory_used: { type: 'integer' },
        memory_total: { type: 'integer' },
        memory_pct: { type: 'number' },
        disks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              drive: { type: 'string' },
              total: { type: 'integer' },
              free: { type: 'integer' },
              used_pct: { type: 'number' },
            },
          },
        },
        net: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              adapter: { type: 'string' },
              ip: { type: 'string' },
              up: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.ProcessList,
    version: '1.0',
    description: '列出运行中的进程，可按 CPU/内存/名称排序',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        sort_by: { type: 'string', enum: ['cpu', 'memory', 'pid', 'name'], default: 'cpu' },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
        filter: filterSchema,
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        processes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pid: { type: 'integer' },
              name: { type: 'string' },
              cpu_pct: { type: 'number' },
              memory_bytes: { type: 'integer' },
              started_at: { type: 'integer' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.ServiceList,
    version: '1.0',
    description: '列出 Windows 服务及运行状态',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: {
            name_pattern: { type: 'string' },
            state: { type: 'string', enum: ['running', 'stopped', 'paused'] },
          },
          additionalProperties: false,
        },
        limit: { type: 'integer', default: 100, minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              display_name: { type: 'string' },
              state: { type: 'string' },
              start_type: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.ShellExec,
    version: '1.1',
    description: '执行 PowerShell / cmd 命令并返回退出码与输出；async:true 时转后台任务立即返回 task_id',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, description: '要执行的命令' },
        shell: { type: 'string', enum: ['powershell', 'cmd'], default: 'powershell' },
        cwd: { type: 'string', description: '工作目录（可选）' },
        timeout_ms: { type: 'integer', default: 30000, minimum: 1000, maximum: 300000 },
        async: { type: 'boolean', default: false, description: '后台执行，立即返回 task_id（用 system.task.* 管理）' },
        wait_forever: { type: 'boolean', default: false, description: '仅 async 模式：不设超时（timeout_ms 失效）' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        exit_code: { type: 'integer' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        duration_ms: { type: 'integer' },
        truncated: { type: 'boolean' },
        killed: { type: 'boolean' },
      },
    },
  },
  {
    name: CapabilityNames.AppList,
    version: '1.0',
    description: '列出已安装软件（读取注册表卸载项 + winget list）',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: { filter: filterSchema },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        apps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
              publisher: { type: 'string' },
              source: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.AppInstall,
    version: '1.0',
    description: '安装软件（优先 winget 静默安装）',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        package: { type: 'string', minLength: 1, description: 'winget 包 ID 或软件名' },
        id: { type: 'string', description: '精确 winget ID（优先使用）' },
        silent: { type: 'boolean', default: true },
        timeout_ms: { type: 'integer', default: 600000, minimum: 10000, maximum: 1800000 },
      },
      required: ['package'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        installed: { type: 'boolean' },
        name: { type: 'string' },
        version: { type: 'string' },
        source: { type: 'string' },
        detail: { type: 'string' },
      },
    },
  },

  // ---------- v2 图形接管：屏幕感知 ----------
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

  // ---------- v2 图形接管：输入控制（默认关闭，需被控端显式开启） ----------
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
    version: '1.0',
    description: '按下按键或组合键（如 ["ctrl","c"]）',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 4,
          description: '按键列表，如 ["ctrl","shift","esc"]',
        },
      },
      required: ['keys'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: { pressed: { type: 'boolean' }, keys: { type: 'array', items: { type: 'string' } } },
    },
  },

  // ---------- v3+ 审计 ----------
  {
    name: CapabilityNames.AuditList,
    version: '1.0',
    description: '查询被控端审计日志：谁在何时调用了什么能力、结果如何',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 1000 },
        since: { type: 'integer', description: '仅返回该时间戳（Unix 毫秒）之后的记录' },
        client_id: { type: 'string', description: '按调用方筛选' },
        type: { type: 'string', enum: ['invoke', 'auth', 'acl', 'agent'], description: '按事件类别筛选' },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        entries: { type: 'array', items: { type: 'object' } },
        total: { type: 'integer', description: '本次读取的总条数（未截断前）' },
        file: { type: 'string', description: '审计文件路径' },
      },
    },
  },

  // ---------- v5 文件传输 ----------
  {
    name: CapabilityNames.FsList,
    version: '1.0',
    description: '列出目录内容（支持 glob 过滤与递归）',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        pattern: { type: 'string', description: 'glob 过滤，如 "*.log"' },
        recursive: { type: 'boolean', default: false },
        max_entries: { type: 'integer', default: 500, minimum: 1, maximum: 5000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              type: { type: 'string', enum: ['file', 'dir', 'other'] },
              size: { type: 'integer' },
              mtime: { type: 'integer' },
            },
          },
        },
        total: { type: 'integer' },
        truncated: { type: 'boolean' },
      },
    },
  },
  {
    name: CapabilityNames.FsStat,
    version: '1.0',
    description: '获取文件或目录的元信息',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        type: { type: 'string', enum: ['file', 'dir', 'other'] },
        size: { type: 'integer' },
        mtime: { type: 'integer' },
        exists: { type: 'boolean' },
      },
    },
  },
  {
    name: CapabilityNames.FsRead,
    version: '1.0',
    description: '读取文件内容（分块：用 offset/max_bytes 续读，eof 标识结束）',
    risk: 'medium',
    params_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
        offset: { type: 'integer', default: 0, minimum: 0, description: '起始字节偏移' },
        max_bytes: { type: 'integer', default: 1048576, minimum: 1, maximum: 8388608, description: '单次读取上限' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        data: { type: 'string' },
        encoding: { type: 'string' },
        offset: { type: 'integer' },
        bytes: { type: 'integer', description: '本次实际读取字节数' },
        total_bytes: { type: 'integer' },
        eof: { type: 'boolean' },
        sha256: { type: 'string', description: '整文件摘要（仅首次读取时返回）' },
      },
    },
  },
  {
    name: CapabilityNames.FsWrite,
    version: '1.0',
    description: '写入文件（分块：append=true 追加；写入走临时文件 + 原子重命名）',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        data: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
        append: { type: 'boolean', default: false },
        create_dirs: { type: 'boolean', default: false },
      },
      required: ['path', 'data'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        written: { type: 'integer', description: '本次写入字节数' },
        total_bytes: { type: 'integer', description: '写入后的文件总大小' },
        path: { type: 'string' },
      },
    },
  },
  {
    name: CapabilityNames.AgentRestart,
    version: '1.0',
    description:
      '受控重启被控端自身（延时后由独立进程/计划任务拉起，重启后自动沿用原配置）。' +
      '解决「配置变更后无法让自身生效」的问题——不会因进程树清理而中断。',
    risk: 'high',
    params_schema: {
      type: 'object',
      properties: {
        delay_ms: {
          type: 'integer',
          description: '延时多少毫秒后重启（默认 2000，给调用方留出返回结果的时间）',
          default: 2000,
        },
        reason: { type: 'string', description: '可选：重启原因（写入审计日志）' },
      },
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        scheduled: { type: 'boolean', description: '重启任务是否已排入' },
        delay_ms: { type: 'integer' },
        mechanism: { type: 'string', description: '使用的机制：scheduled-task / detached-spawn' },
        message: { type: 'string' },
      },
    },
  },
  {
    name: CapabilityNames.WindowList,
    version: '1.0',
    description:
      '列出当前可见的顶层窗口（标题、所属进程、精确矩形、是否前台窗口）。' +
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
      },
    },
  },
  {
    name: CapabilityNames.ScreenFind,
    version: '1.1',
    description:
      '在界面中查找 UI 元素并返回其**屏幕坐标**。默认 UIA（Windows UI Automation），' +
      '找不到时自动降级为 OCR（截图识别，支持自绘 UI 如 Electron/Qt）。返回中心点坐标，直接喂给 input.mouse.click。',
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
          enum: ['auto', 'uia', 'ocr'],
          default: 'auto',
          description: 'auto=UIA 优先+OCR 兜底；uia=仅 UIA；ocr=仅截图识别',
        },
        limit: { type: 'integer', default: 20 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        engine: { type: 'string', description: '实际使用的引擎：uia | ocr' },
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
    name: CapabilityNames.TaskList,
    version: '1.0',
    description: '列出当前后台异步任务（system.shell.exec 以 async:true 启动的命令）。',
    risk: 'low',
    params_schema: { type: 'object', properties: {}, additionalProperties: false },
    returns_schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'string' },
              command: { type: 'string', description: '命令（sha256 摘要后前 8 位）' },
              state: { type: 'string', description: 'running | done | killed | failed' },
              started_at: { type: 'integer' },
              duration_ms: { type: 'integer' },
              exit_code: { type: 'integer' },
            },
          },
        },
      },
    },
  },
  {
    name: CapabilityNames.TaskGet,
    version: '1.0',
    description:
      '查询异步任务状态与输出。任务结束后仍可查询（保留最近 N 条），输出支持增量读取（offset）。',
    risk: 'low',
    params_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        stream: { type: 'string', enum: ['stdout', 'stderr'], default: 'stdout' },
        offset: {
          type: 'integer',
          description: '从输出的第 offset 字节开始读（增量拉取）',
          default: 0,
        },
        max_bytes: { type: 'integer', default: 262144 },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        state: { type: 'string' },
        exit_code: { type: 'integer' },
        started_at: { type: 'integer' },
        duration_ms: { type: 'integer' },
        data: { type: 'string', description: '本次读取到的输出片段' },
        offset: { type: 'integer', description: '已读到的字节位置（下次续读用）' },
        total_bytes: { type: 'integer' },
      },
    },
  },
  {
    name: CapabilityNames.TaskKill,
    version: '1.0',
    description: '强制终止一个后台异步任务（杀整棵进程树）。',
    risk: 'medium',
    params_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: { killed: { type: 'boolean' }, task_id: { type: 'string' } },
    },
  },
  {
    name: CapabilityNames.ClipGet,
    version: '1.0',
    description: '读取被控端剪贴板文本（Windows: Get-Clipboard；macOS: pbpaste）。',
    risk: 'medium',
    params_schema: { type: 'object', properties: {}, additionalProperties: false },
    returns_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
    },
  },
  {
    name: CapabilityNames.ClipSet,
    version: '1.0',
    description: '向被控端剪贴板写入文本（Windows: Set-Clipboard；macOS: pbcopy）。',
    risk: 'medium',
    params_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    returns_schema: {
      type: 'object',
      properties: { written: { type: 'integer', description: '写入的字符数' } },
    },
  },
];

/** 按名称查找能力描述。 */
export function findCapability(name: string): CapabilityDescriptor | undefined {
  return CAPABILITY_MANIFEST.find((c) => c.name === name);
}
