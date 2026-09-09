export function mountScenarios(pane: HTMLElement): () => void {
  pane.innerHTML = '<h2>场景（待 Task 8 实现）</h2>';
  return () => { pane.innerHTML = ''; };
}
