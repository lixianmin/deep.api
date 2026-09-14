#!/usr/bin/env python3
"""在已继承的 fd 上申请 flock 独占锁；拿不到就轮询等待并打印持有者诊断。

用法: with-lock.py <fd> <timeout_seconds> <diag_json_path>
退出码: 0 拿到锁; 3 超时
"""
import fcntl
import json
import sys
import time

POLL_INTERVAL = 0.5    # 轮询间隔（秒）：短到能快速抢锁，长到不烧 CPU
REPORT_INTERVAL = 5    # 等待进度打印间隔（秒）：人看得清又不刷屏

def describe(diag_path, now):
    """读诊断文件得到持有者状态。诊断不参与正确性判断，任何异常一律降级为 '?'。"""
    try:
        with open(diag_path, encoding='utf-8') as fh:
            data = json.load(fh)
    except Exception:
        return 'held_by=? phase=? elapsed=?'
    elapsed = '?'
    epoch = data.get('startedAtEpoch')
    if isinstance(epoch, (int, float)):
        elapsed = '%ds' % int(now - epoch)
    return 'held_by=%s phase=%s elapsed=%s' % (
        data.get('branch', '?'), data.get('phase', '?'), elapsed)


def main():
    fd = int(sys.argv[1])
    timeout = float(sys.argv[2])
    diag_path = sys.argv[3]
    deadline = time.monotonic() + timeout
    last_report = None   # None -> 首次失败的轮询立即打印一行 WAITING
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return 0
        except BlockingIOError:
            now = time.monotonic()
            if now >= deadline:
                sys.stderr.write('[deep-api-merge] ERROR 3 等待锁超时（%ds）\n' % int(timeout))
                return 3
            if last_report is None or now - last_report >= REPORT_INTERVAL:
                last_report = now
                print('[deep-api-merge] WAITING %s' % describe(diag_path, time.time()))
                sys.stdout.flush()
            time.sleep(POLL_INTERVAL)


if __name__ == '__main__':
    sys.exit(main())
