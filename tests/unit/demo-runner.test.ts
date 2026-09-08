import { describe, it, expect, beforeEach } from 'vitest';
import { mountDemo } from '../../src/demo/demo-runner';

const fakeModels = { data: [{ id: 'm1' }, { id: 'm2' }] };
const fakeNonStream = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };

function installFakeApi(opts: { onCreate?: (params: any) => Promise<any> } = {}) {
  (window as any).deepApi = {
    models: { list: async () => fakeModels },
    chat: { completions: { create: opts.onCreate ?? (async () => fakeNonStream) } },
  };
}

describe('mountDemo (popup 内嵌 demo 控件)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    installFakeApi();
  });

  it('mount 渲染 demo 控件', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const unmount = mountDemo(root);
    expect(root.querySelector('.demo-panel')).toBeTruthy();
    expect(root.querySelectorAll('button[data-act]').length).toBe(6);
    unmount();
  });

  it('unmount 后清空容器', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const unmount = mountDemo(root);
    expect(root.innerHTML).not.toBe('');
    unmount();
    expect(root.innerHTML).toBe('');
  });

  it('多次 mount 互不污染', () => {
    const r1 = document.createElement('div'); document.body.appendChild(r1);
    const r2 = document.createElement('div'); document.body.appendChild(r2);
    const u1 = mountDemo(r1);
    const u2 = mountDemo(r2);
    expect(r1.querySelector('.demo-panel')).toBeTruthy();
    expect(r2.querySelector('.demo-panel')).toBeTruthy();
    u1();
    expect(r1.querySelector('.demo-panel')).toBeNull();
    expect(r2.querySelector('.demo-panel')).toBeTruthy();
    u2();
  });

  it('点击"非流式问答"按钮调用 deepApi.chat.completions.create', async () => {
    let createCalled = false;
    installFakeApi({ onCreate: async () => { createCalled = true; return fakeNonStream; } });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const unmount = mountDemo(root);
    await new Promise(r => setTimeout(r, 10));
    const btn = root.querySelector('button[data-act="one"]') as HTMLButtonElement;
    btn.click();
    await new Promise(r => setTimeout(r, 10));
    expect(createCalled).toBe(true);
    unmount();
  });
});
