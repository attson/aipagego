export class PairingWaitTimeoutError extends Error {
  constructor(timeoutMs: number, pairUrl: string | null) {
    super(
      `等待浏览器授权超时（${Math.ceil(timeoutMs / 1000)} 秒）。` +
        (pairUrl ? `请打开配对页 ${pairUrl} 完成授权后重试。` : "")
    );
    this.name = "PairingWaitTimeoutError";
  }
}
