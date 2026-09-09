export function mountSse(pane: HTMLElement): () => void {
  pane.innerHTML = '<h2>SSE 帧（待 Task 7 实现）</h2>';
  return () => { pane.innerHTML = ''; };
}
