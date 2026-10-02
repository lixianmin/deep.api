/**
 * ChatGPT bridge 协议：SW 发送端与页面 MAIN world 接收端**共享**的 send 指令契约。
 *
 * 为什么把类型与判定谓词放在这里（2026-10-04，fix/chatgpt-send-envelope-mismatch）：
 * send 指令横跨两个模块——发送端 src/background/providers/chatgpt/bridge-client.ts（SW），
 * 接收端 src/content/chatgpt-bridge-main.ts（MAIN world）。两个 bundle 各自打包，
 * 原本各自定义/各自判断形状，**没有任何类型把两侧绑在一起**：
 *   - 发送端发 `{ __deepApiChatGPT: true, kind: 'send', ... }`
 *   - 接收端判 `__deepApiChatGPT === 'send'`
 * 于是 send 在接收端第一行就被 return 掉，静默丢弃：专属标签页打开、relay 连上、
 * composer 却永远不被填词，用户侧表现为「无报错、无回复、120s 超时」。
 * 两侧各自的单测都在断言自己那半边形状，全绿——**跨模块契约没有测试，就是没有契约**。
 *
 * 修法（唯一真相）：本协议所有消息统一用信封 `{ __deepApiChatGPT: true, kind: '<动作>' }`
 * （relay 的页面→SW 过滤、bridge-client 的入站过滤都要求 `=== true`），send 也照此办理；
 * 类型与判定谓词收敛到本模块，发送端 import 类型标注字面量、接收端 import 谓词做判定——
 * 形状再漂移时编译器会先拦下来（见 tests/unit/chatgpt-send-contract.test.ts）。
 *
 * 约定：本模块只描述**页面侧**协议（SW ↔ 页面 MAIN world）。SW 与内部 adapter 之间
 * 走 src/shared/protocol.ts 的 `__deepApi` 协议，两者不要混。
 */

/** SW → MAIN world 的 send 指令：让页面把 text 发进（或切到）指定会话。 */
export interface ChatGPTSendMsg {
  /** 信封标记。必须字面 true——页面上的任意脚本都能 postMessage，只有本值才是我们自己的消息。 */
  __deepApiChatGPT: true;
  kind: 'send';
  /** 请求 id：页面回流的 stream-start / frame / done / error 都带同一个 id，SW 据此路由。 */
  requestId: string;
  /** 要发进 composer 的文本。 */
  text: string;
  /** null = 新会话（页面会先回到 '/'）；非 null = 切到 /c/<id> 再发。发送端总是显式给值。 */
  conversationId: string | null;
}

/**
 * 判定一条页面收到的消息是不是 send 指令，同时把 unknown 收窄成 ChatGPTSendMsg。
 *
 * 严格性说明：conversationId 只接受 string | null（不接受缺失/undefined）。
 * 唯一生产者是 SW 发送端，它总是显式写 null 或字符串；宽松兜底只会让畸形包
 * 溜进 handleSend，把「形状不对」变成「导航到错误会话」这种更难查的问题。
 */
export function isChatGPTSendMsg(v: unknown): v is ChatGPTSendMsg {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as {
    __deepApiChatGPT?: unknown;
    kind?: unknown;
    requestId?: unknown;
    text?: unknown;
    conversationId?: unknown;
  };
  if (m.__deepApiChatGPT !== true) return false;
  if (m.kind !== 'send') return false;
  if (typeof m.requestId !== 'string') return false;
  if (typeof m.text !== 'string') return false;
  return typeof m.conversationId === 'string' || m.conversationId === null;
}
