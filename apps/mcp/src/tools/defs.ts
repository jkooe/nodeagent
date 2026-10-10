/**
 * MCP 工具定义清单（2026-10 从 index.ts 抽出）。
 *
 * ⚠️ **顺序即对外呈现顺序**：改动会改变客户端看到的工具列表次序。
 * 拆分时用「工具名序列 sha256」做回归证据（见 tests/unit/mcp-tools.test.mjs）。
 *
 * 定义与实现的分工：本文件只管「暴露什么」，分发逻辑仍在 index.ts 的 resolveToolCall。
 */
export const TOOLS = [
  {
    name: 'na_status',
    description:
      '查询被控端 Windows 的资源状态：CPU 占用率、内存使用、各磁盘容量、网络适配器。当用户问"Windows 卡不卡""内存够不够""磁盘满了吗"时使用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_system_info',
    description:
      '查询被控端 Windows 的系统基本信息：主机名、操作系统版本、CPU 型号、内存总量、开机时长、是否管理员。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_exec',
    description:
      '在被控端 Windows 上执行 PowerShell 命令并返回退出码与输出。用于查日志、查目录、重启服务、运行脚本等任意命令场景。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
        timeout_ms: { type: 'integer', description: '超时毫秒数，默认 30000，最大 300000' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_install',
    description:
      '在被控端 Windows 上安装软件（winget 静默安装）。当用户说"在 Windows 上装个 XX""帮我装 VSCode"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '软件名或 winget 包 ID，如 Microsoft.VisualStudioCode' },
        id: { type: 'string', description: '精确 winget ID（可选，优先使用）' },
      },
      required: ['package'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_app_list',
    description: '列出被控端 Windows 上已安装的软件及其版本。',
    inputSchema: {
      type: 'object',
      properties: { name_pattern: { type: 'string', description: '可选：按名称筛选（不区分大小写）' } },
      additionalProperties: false,
    },
  },
  {
    name: 'na_process_list',
    description: '列出被控端 Windows 上运行的进程，可按 CPU 或内存排序。',
    inputSchema: {
      type: 'object',
      properties: {
        sort_by: { type: 'string', enum: ['cpu', 'memory', 'pid', 'name'], description: '排序字段，默认 cpu' },
        limit: { type: 'integer', description: '返回条数，默认 20' },
        name_pattern: { type: 'string', description: '可选：按进程名筛选' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_service_list',
    description: '列出被控端 Windows 的系统服务及其运行状态。',
    inputSchema: {
      type: 'object',
      properties: {
        name_pattern: { type: 'string', description: '可选：按服务名筛选' },
        state: { type: 'string', enum: ['running', 'stopped', 'paused'], description: '可选：按状态筛选' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_screenshot',
    description:
      '截取被控端 Windows 屏幕并直接返回图片。当用户问"Windows 现在画面是什么样""帮我看下屏幕"，或需要视觉确认操作结果时使用。屏幕较大时建议 scale 设 0.5 以减小体积。',
    inputSchema: {
      type: 'object',
      properties: {
        scale: { type: 'number', description: '缩放比例 0.1~1.0，默认 1' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '默认 jpeg' },
        region: { type: 'string', description: '可选截取区域，格式 "x,y,width,height"' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_mouse',
    description:
      '控制被控端鼠标（需被控端已开启输入控制）。action: move 移动到 (x,y)；click 点击（给了 x/y 则先移动，否则点当前位置）；scroll 滚动 delta 格。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'click', 'scroll'], description: '操作类型' },
        x: { type: 'integer', description: 'X 坐标' },
        y: { type: 'integer', description: 'Y 坐标' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click 的按钮，默认 left' },
        delta: { type: 'integer', description: 'scroll 的滚动格数（正数向上）' },
        duration_ms: { type: 'integer', description: 'move 的平滑移动耗时（毫秒）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_key',
    description:
      '控制被控端键盘（需被控端已开启输入控制）。\n' +
      'action: type = 输入一段文本；press = 按**快捷键**。\n' +
      'press 支持四种形式（一次只用一种）：\n' +
      '① hotkey 单条字符串，如 "ctrl+shift+esc"、"win+d"、"alt+tab"；\n' +
      '② hotkeys 字符串序列，如 ["ctrl+c","ctrl+v"]；\n' +
      '③ preset 预设语义名，如 copy/paste/save/show_desktop/lock_screen/screenshot/' +
      'zoom_in/music_next/volume_mute_toggle（约 50 个）；\n' +
      '④ keys 老形式数组，如 ["ctrl","c"]。\n' +
      '按键覆盖：字母数字、F1-F24、左右侧修饰键（lalt/rctrl/lwin…）、小键盘（numpad7、numpad_add…）、' +
      'OEM 符号键（oem_plus/oem_comma/oem_period…，支持 win+d、ctrl++、win+. 这类组合）、' +
      '媒体键（media_next/music_play_pause…）、浏览器键、IME 键、系统键。\n' +
      '可配：hold_ms 长按（≤5000）；route=foreground（默认，注入当前焦点）或 ' +
      'route=post（向 target_pid 指定进程的全部顶层窗口 PostMessage，目标在后台时可用，' +
      '但游戏/部分输入型程序不响应后台键消息）。\n' +
      '媒体键整条序列会自动走 WM_APPCOMMAND（可定向 target_pid，窗口被遮挡也有效）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['type', 'press'], description: '操作类型' },
        text: { type: 'string', description: 'type 时输入的文本' },
        hotkey: { type: 'string', maxLength: 64, description: '单条热键字符串，如 "ctrl+shift+esc"；支持 + - 空格分隔' },
        hotkeys: { type: 'array', items: { type: 'string' }, maxItems: 50, description: '热键字符串序列，如 ["ctrl+c","ctrl+v"]' },
        preset: { type: 'string', description: '预设语义名（单个），如 copy / show_desktop / task_manager' },
        presets: { type: 'array', items: { type: 'string' }, maxItems: 50, description: '多个预设名 = 序列' },
        keys: { type: 'array', items: { type: 'string' }, description: '（老形式）和弦按键数组，如 ["ctrl","c"]' },
        repeat: { type: 'integer', minimum: 1, maximum: 50, description: '重复次数（默认 1）' },
        hold_ms: { type: 'integer', minimum: 0, maximum: 5000, description: '长按保持毫秒数（按下后延时再释放）' },
        route: { type: 'string', enum: ['foreground', 'post'], description: '投递路由，默认 foreground' },
        target_pid: { type: 'integer', minimum: 0, description: '目标进程 PID（媒体键定向或 route=post 必填）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_audit',
    description:
      '查询被控端审计日志：谁在何时调用了什么能力、结果如何。用于安全审计与问题追溯，例如"最近谁在操作这台 Windows"。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回条数，默认 20' },
        since: { type: 'integer', description: '仅返回该 Unix 毫秒时间戳之后的记录' },
        client_id: { type: 'string', description: '按调用方筛选' },
        type: { type: 'string', enum: ['invoke', 'auth', 'acl', 'agent'], description: '按事件类别筛选' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_discover',
    description:
      '发现局域网内可用的 nodeagent 被控端设备（监听 UDP 广播）。当用户问"有哪些 Windows 机器可用"、或尚未配置被控端时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', description: '监听时长（秒），默认 3，上限 15' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_fs_list',
    description: '列出被控端某目录下的文件与子目录。用户问"Windows 上某目录有什么文件"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录绝对路径，如 C:\\\\Users\\\\me\\\\Desktop' },
        pattern: { type: 'string', description: '可选 glob 过滤，如 "*.log"' },
        recursive: { type: 'boolean', description: '是否递归子目录' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_fs_read',
    description:
      '读取被控端文件内容（默认 UTF-8）。文件较大时会分块返回，用 offset 续读、看 eof 判断结束。适合读取日志、配置、脚本。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: '默认 utf8；二进制文件用 base64' },
        offset: { type: 'integer', description: '起始字节偏移，默认 0' },
        max_bytes: { type: 'integer', description: '单次读取上限，默认 1MB，最大 8MB' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_fs_write',
    description:
      '向被控端写入文件（自动原子写，不会留半截文件）。已有文件可用 append: true 追加；目录不存在时设 create_dirs: true。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        data: { type: 'string', description: '写入内容' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: '默认 utf8' },
        append: { type: 'boolean', description: '是否追加（默认覆盖）' },
        create_dirs: { type: 'boolean', description: '目录不存在时自动创建' },
      },
      required: ['path', 'data'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_fs_stat',
    description: '查看被控端文件或目录的元信息（类型 / 大小 / 修改时间），用于读文件前先判断类型与大小。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录绝对路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_nodes',
    description: '列出已配置的 nodeagent 被控端设备（● 为当前默认设备）。多台 Windows 时使用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_restart',
    description:
      '受控重启被控端（约 4 秒后生效，自动恢复原配置与端口）。配置变更后让 agent 自身生效时使用；' +
      '重启期间连接会短暂中断，等待约 5 秒后即可继续调用其他工具。',
    inputSchema: {
      type: 'object',
      properties: {
        delay_ms: { type: 'integer', description: '延时毫秒（默认 2000）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_await',
    description:
      '等待一个条件成立再返回（只读低危，v1.6.0）。\n' +
      '四类条件：window=等窗口出现/消失；control=等界面元素出现/消失（复用 screen.find）；' +
      'process=等进程出现/消失；file=等文件出现/消失。\n' +
      'state=present（默认，等出现）或 absent（等消失）。\n' +
      '用途：把 GUI 操作从「按一下→睡几秒→截图碰运气」变成**可断言**流程：\n' +
      '  await control(text:"立即安装") → na_mouse click → await control(text:"完成", timeout:60000) → click → await absent(text:"安装中")\n' +
      '超时是**正常返回**（satisfied:false + note，不抛异常）；轮询期单次异常不视为失败。',
    inputSchema: {
      type: 'object',
      properties: {
        condition: { type: 'string', enum: ['window', 'control', 'process', 'file'], description: '等待哪类条件' },
        state: { type: 'string', enum: ['present', 'absent'], default: 'present', description: '等出现还是等消失' },
        timeout_ms: { type: 'integer', minimum: 0, maximum: 60000, default: 5000, description: '总超时' },
        interval_ms: { type: 'integer', minimum: 50, maximum: 5000, default: 400, description: '轮询间隔' },
        text: { type: 'string', description: 'control 条件：元素文本' },
        title: { type: 'string', description: 'window 条件：窗口标题（正则）' },
        process: { type: 'string', description: 'process 条件：进程名（正则）' },
        path: { type: 'string', description: 'file 条件：文件路径' },
        where: { type: 'object', description: 'v2.0.0 属性谓词（仅 UIA）：{ enabled?, selected?, value?, toggle? }' },
        any_of: { type: 'array', maxItems: 8, description: 'v2.0.0 组合条件：每项一个条件对象，任一命中即算' },
      },
      required: ['condition'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_monitor',
    description:
      '定时采样并落盘，事后回看（v2.0.0，治间歇性问题）。\n' +
      'action=start：起一个采样。source=port（target="host:port"，测连通性与延迟）/' +
      'process（target=进程名，测存活）/command（target=命令，取退出码）/metric（CPU·内存，无需 target）。\n' +
      'action=report：读回样本序列与**摘要**（port/process 给「断了几次 + 最长连续中断」；' +
      'metric 给 CPU/内存 min·avg·max；command 给成功失败数与退出码）。\n' +
      'action=stop/list/delete。\n' +
      '典型：先 start port 采 5 分钟，再 report 回答「这 5 分钟断过几次、最长断了多久」。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'report', 'stop', 'list', 'delete'], description: '操作' },
        source: { type: 'string', enum: ['port', 'process', 'command', 'metric'], description: 'start 时的采样源' },
        target: { type: 'string', description: 'port=host:port；process=进程名；command=命令' },
        interval_ms: { type: 'integer', minimum: 500, maximum: 600000, description: '采样间隔（默认 2000）' },
        id: { type: 'string', description: '监控 id（report/stop/delete 必需；start 可自定义）' },
        limit: { type: 'integer', description: 'report 最多回多少样本' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_log',
    description:
      '在被控端侧过滤日志，只回匹配行（v2.0.0，只读）。日志常几万行，整份拉回既慢又占带宽 —— ' +
      '本工具把过滤下推到被控端（流式逐行读）。支持 pattern（正则）/level（ERROR|WARN|INFO|DEBUG）/\n' +
      'since（Unix ms）/offset/limit/tail（取末尾 N 条）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '日志文件路径（受被控端 fs_roots 限制）' },
        pattern: { type: 'string', description: '正则过滤（忽略大小写）' },
        level: { type: 'string', enum: ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'], description: '按级别过滤' },
        since: { type: 'integer', description: '只回该 Unix ms 之后的行' },
        offset: { type: 'integer', description: '跳过前 N 条命中' },
        limit: { type: 'integer', description: '最多回多少条（默认 100，上限 5000）' },
        tail: { type: 'boolean', description: '取末尾 N 条' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_window_list',
    description:
      '列出被控端当前可见的顶层窗口（标题 / 进程 / 精确矩形 / 是否前台）。' +
      'GUI 操作第一步：先拿到窗口矩形，再在其范围内定位，避免全屏猜坐标。',
    inputSchema: {
      type: 'object',
      properties: {
        title_pattern: { type: 'string', description: '可选：按标题正则过滤' },
        limit: { type: 'integer', description: '返回上限（默认 50）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_window_focus',
    description: '将被控端的指定窗口（按标题正则）置前并聚焦，返回其精确矩形。点击某窗口内容之前先调用。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '窗口标题（正则，匹配第一个）' },
        wait_ms: { type: 'integer', description: '等待窗口出现（应用刚启动时用）' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_screen_find',
    description:
      '在被控端界面中查找 UI 元素并返回其屏幕坐标（Windows UI Automation）。' +
      '返回中心点 (x,y)，可直接配合 na_mouse 的 click 使用。找不到时自动降级为 OCR 截图识别（支持自绘 UI）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要查找的文本（子串匹配，不区分大小写）' },
        window: { type: 'string', description: '可选：限定在该窗口标题（正则）内查找' },
        control_type: {
          type: 'string',
          description: '可选：控件类型，如 Button / MenuItem / Edit / ListItem（仅 UIA）',
        },
        method: {
          type: 'string',
          enum: ['auto', 'uia', 'ocr'],
          description: 'auto=UIA 优先+OCR 兜底；uia=仅 UIA；ocr=仅截图识别',
        },
        limit: { type: 'integer', description: '返回上限（默认 20）' },
        wait_ms: {
          type: 'integer',
          description: '等待元素出现的上限毫秒（0=只查一次）。界面有动画/加载时建议 3000~8000',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_bg',
    description:
      '在被控端后台执行长命令（如下载、安装、日志采样），立即返回 task_id 不阻塞。' +
      '之后用 na_task 查询输出或终止。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
        timeout_ms: { type: 'integer', description: '超时毫秒（默认 300000，即 5 分钟）' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_task',
    description:
      '管理后台任务：action=list 列出；action=get 读取输出（offset 支持增量续读）；action=kill 终止。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'kill'], description: '默认 list' },
        task_id: { type: 'string', description: 'get/kill 时必填' },
        offset: { type: 'integer', description: 'get 时从第 N 字节续读（默认 0）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_macro_run',
    description:
      '回放一段 GUI 宏（步骤序列）：把一次成功操作固化后重复执行。' +
      '步骤支持 focus/find/click/type/key/drag/sleep/exec/clip/assert/capture，' +
      '可带 retry 重试、optional 可选、${VAR} 变量替换。返回每步结果（含失败定位）。',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '步骤数组',
          items: { type: 'object', additionalProperties: true },
        },
        vars: { type: 'object', description: '可选：变量表（供 ${NAME} 替换）' },
        default_delay_ms: { type: 'integer', description: '每步之间默认等待' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_net_status',
    description:
      '查看被控端网络现状：各网卡 IP/网关、**待确认的网络变更**（含剩余秒数）、历史配置备份。' +
      '改网络前后都应先看它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_net_apply',
    description:
      '**改被控端网络**（高危）：两阶段提交 —— 先备份当前配置，再应用变更，并注册 OS 级定时回滚任务；' +
      '你必须在 confirm_within_ms 内（可能要在新地址上重连后）用 na_net_confirm 确认，' +
      '否则自动回滚到变更前配置。用于远程改 IP / 切 DHCP 这类「改错就失联」的操作。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['static', 'dhcp', 'command'] },
        interface: { type: 'string', description: '网卡别名；省略则用带默认网关的那块' },
        ip: { type: 'string' },
        mask: { type: 'string' },
        gateway: { type: 'string' },
        dns: { type: 'array', items: { type: 'string' } },
        command: { type: 'string', description: 'mode=command 时执行的自定义变更命令' },
        confirm_within_ms: { type: 'integer', description: '确认窗口毫秒（默认 60000，最小 15000）' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_net_confirm',
    description: '确认（提交）网络变更，取消自动回滚。不传 task_name 则取消全部待确认项。',
    inputSchema: {
      type: 'object',
      properties: { task_name: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'na_agent_update',
    description:
      '**被控端自更新**：让它自己从 URL 下载新版本 agent 并替换自身（校验哈希 → 备份 → 原子替换 → 重启）。' +
      '用于控制端与被控端不可达、但被控端能上网的场景（跨网段/NAT/异地）。' +
      'sha256 必填（安全底线）；不确定时可先 dry_run=true 只校验不改动。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '更新包地址（http/https）' },
        sha256: { type: 'string', description: '期望哈希（12~64 位十六进制）' },
        restart: { type: 'boolean', description: '替换后是否重启（默认 true）' },
        dry_run: { type: 'boolean', description: '只下载校验，不改动文件' },
      },
      required: ['url', 'sha256'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_audio_get',
    description: '读取被控端默认播放设备的静音状态与主音量（Windows: Core Audio / macOS: osascript）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_audio_set',
    description:
      '设置被控端静音开关或主音量（可读回实际状态，故为确定性设置而非切换）。' +
      '常用于「把远端那台机器静音」。mute 与 volume 至少给一个。',
    inputSchema: {
      type: 'object',
      properties: {
        mute: { type: 'boolean', description: 'true=静音，false=取消静音' },
        volume: { type: 'integer', description: '主音量 0-100' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_metrics',
    description:
      '按 PRD 2.2 汇总被控端成功指标（闭环成功率 / 装软件成功率 / P95 时延 / 安全拦截率）' +
      '及达标判定与按能力细分。排查「成功率掉了没有／哪个能力最慢」时用。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: '可选：只统计该 Unix 毫秒之后的审计条目' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_event_watch',
    description:
      '订阅被控端事件：file=文件变动、process=进程启停、net=监听端口开闭。' +
      'MCP 无法接收推送，事件会进入服务端缓冲，用 na_event_poll 拉取。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['file', 'process', 'net'] },
        path: { type: 'string', description: 'file 类型：监控的目录/文件路径' },
        pattern: { type: 'string', description: '可选：文件名或进程名 glob（如 *.log、chrome*）' },
        recursive: { type: 'boolean', description: 'file 类型：是否递归子目录' },
        interval_ms: { type: 'integer', description: 'process/net 采样间隔（1000~60000，默认 5000）' },
        notify: {
          type: 'boolean',
          description:
            '开启实时推送（MCP 日志通知）；宿主若不展示日志则退化为 na_event_poll 拉取，无副作用',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_event_poll',
    description:
      '拉取已缓冲的被控端事件（增量：传上次返回的 next_cursor）。' +
      '典型用法：先 na_event_watch 订阅，稍后 na_event_poll 查看期间发生了什么。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回条数（默认 50）' },
        since: { type: 'integer', description: '游标：上次返回的 next_cursor' },
        watch_id: { type: 'string', description: '可选：只看某个订阅' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_event_list',
    description: '列出当前生效的事件订阅（含各自已产生的事件数）与缓冲区大小。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'na_event_unwatch',
    description: '取消一个事件订阅（长时间不用的订阅应主动取消，避免浪费被控端资源）。',
    inputSchema: {
      type: 'object',
      properties: { watch_id: { type: 'string' } },
      required: ['watch_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'na_record',
    description:
      '录制被控端屏幕为帧序列（JPEG），检测到 ffmpeg 时额外封装 mp4。' +
      '用于复现间歇性问题或记录 GUI 操作；产物在被控端目录，用 na_fs_read 取回。',
    inputSchema: {
      type: 'object',
      properties: {
        duration_ms: { type: 'integer', description: '时长毫秒（1000~60000，默认 5000）' },
        fps: { type: 'integer', description: '帧率 1~10（默认 2）' },
        scale: { type: 'number', description: '全屏缩放 0.1~1（默认 0.5）' },
        region: { type: 'string', description: '可选 "x,y,width,height" 只录该区域' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_clip',
    description:
      '读写被控端剪贴板：action=get 读取文本；action=set 写入文本。要粘贴到 GUI 输入框时先 set 再用 na_key 按 ctrl+v。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: '默认 get' },
        text: { type: 'string', description: 'set 时要写入的文本' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'na_use',
    description: '切换本次会话的目标设备（不影响 CLI 的默认设备）。用户说"切换到某台机器"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '设备名（用 na_nodes 查看）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
] as const;
