// CLI 帮助文本（从 index.ts 拆出）
export const HELP = `nodeagent —— 跨机 AI 接管框架（控制端 CLI）

用法:
  nodeagent connect <host> [--port 8765] [--key <key>] [--insecure] [--id mac_01] [--auth-mode ed25519]
      配置并连接被控端（握手成功后打印能力清单）
      经 Hub 中转: 追加 --hub-token <Hub 令牌> --hub-node <被控端 node_id> (v6)

  nodeagent keygen [--id mac_01]      生成 Ed25519 密钥对并输出被控端 ACL 配置片段 (v3 零信任)
  nodeagent nodes                     列出已配置的被控端设备 (v5 多设备)
  nodeagent use <设备名>               切换当前默认设备
  nodeagent remove <设备名>            移除设备
  nodeagent audit [--limit 20] [--type invoke|auth|acl|agent] [--client-id X] [--since <ms>]
                                      查询被控端审计日志 (v3+)
  nodeagent audit verify              校验审计链完整性（防篡改检测）(v11)
  nodeagent metrics [--since <ms>]    成功指标：闭环率/装软件率/P95/拦截率 (v13)
  nodeagent audio [get]                 查看被控端静音状态与主音量 (v17)
  nodeagent audio set [--mute on|off] [--volume 0-100]   设置静音 / 音量
  nodeagent net [status]              网络现状 + 待确认变更 (v16)
  nodeagent net apply --mode static --ip <ip> --mask <m> [--gateway g] --yes
                                      改网络（两阶段提交：未确认则自动回滚，不会失联）
  nodeagent net confirm [--task-name X]  确认提交网络变更（取消自动回滚）
  nodeagent discover [--wait 5]       发现局域网内的被控端（UDP 广播，免手抄 IP）(v4)

文件传输 (v5):
  nodeagent ls <远端路径> [--recursive] [--pattern "*.log"]     列目录
  nodeagent stat <远端路径>                                      看元信息
  nodeagent cat <远端路径> [--out 本地文件]                       读文本（首块）
  nodeagent pull <远端路径> [--out 本地文件]                      下载（自动分块，支持大文件）
  nodeagent push <本地文件> <远端路径> [--create-dirs]            上传（自动分块）

  nodeagent info                      查看系统信息 (system.info)
  nodeagent status                    查看资源状态 (system.status)
  nodeagent ps [--limit 20]           查看进程 (system.process.list)
  nodeagent services [--limit 20]     查看服务 (system.service.list)
  nodeagent exec "<命令>"              执行命令 (system.shell.exec)
  nodeagent apps                      列出已安装软件 (app.list)
  nodeagent install <包名|ID>          安装软件 (app.install)
  nodeagent restart [--delay 2000]    受控重启被控端（配置变更后让自身生效）(v7)
  nodeagent bg "<命令>" [--timeout-ms N]  后台执行长命令，立即返回 task_id (v10)
  nodeagent tasks                    列出后台任务
  nodeagent task <id> [--offset N] [--kill]  读取/终止后台任务（支持增量续读）
  nodeagent clip [--set "文本"] [--out <路径>] [--image-file <路径>]
                                      读/写剪贴板文本或图片（--out 保存图片）(v11)
  nodeagent macro run <file.json> [--var k=v] [--out <目录>]
                                      回放 GUI 宏（步骤序列，逐步校验）(v12)
  nodeagent macro validate <file.json> | macro init [文件]
  nodeagent events [--kind file|process|net] [--path <路径>] [--pattern G] [--seconds 15]
                                      订阅事件并实时接收推送（无 --kind 则列出订阅）(v12)
  nodeagent record [--duration 5000] [--fps 2] [--scale 0.5] [--region x,y,w,h]
                                      录屏为帧序列（有 ffmpeg 则封装 mp4）(v11)
  nodeagent deploy <agent.mjs> [--path <远端路径>] [--check] [--force]
                                      一键升级被控端 (v11/v18)：比指纹 → 备份 → 上传 → 重启
                                      → 轮询校验；--check 只比对不部署
  nodeagent group [add <组名> <设备...> | remove <组名>]  设备分组管理 (v12)
  nodeagent fanout <能力名> [--nodes a,b|@组名] [--args JSON]
                                      多设备并发调用并汇总 (v11)
  nodeagent daemon [start|stop|status] 常驻连接池（批量操作提速 5~10 倍）(v10)
  nodeagent list                      列出被控端可用能力
  nodeagent invoke <capability> [--args '<json>']   通用调用

图形操作 (v2，输入控制需被控端开启 allow_input):
  nodeagent screen                    显示器信息 (screen.info)
  nodeagent screenshot [--out f.jpg] [--scale 0.5] [--region x,y,w,h] [--format jpeg]
                                      截屏并保存 (screen.capture)
  nodeagent mouse move <x> <y> [--duration 300]
  nodeagent mouse click [<x> <y>] [--button left|right|middle]
  nodeagent mouse drag <x1> <y1> <x2> <y2> 鼠标拖拽（拖文件/框选）(v11)
  nodeagent mouse scroll <delta>
  nodeagent key type "<文本>" [--interval 10]
  nodeagent key press <键1> [键2] ...  （组合键，如 ctrl c）

通用选项:
  --node <设备名>  本次命令临时指定目标设备（不改变 current）
                   可放命令后（nodeagent info --node win_b）或前置（nodeagent --node=win_b info）
  --json      以原始 JSON 输出
  --config    显示当前配置路径
`;
