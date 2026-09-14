#!/bin/bash
# deep-api-merge —— 并发安全的合并脚本（从 spice 仓 scripts/spice-merge.sh 复制适配）
# 锁/临界区设计见 spice 仓 docs/superpowers/specs/2026-09-15-concurrent-merge-lock-design.md
# 退出码: 0 成功 / 2 前置检查失败 / 3 等待锁超时 / 4 rebase 冲突 / 5 测试失败
#         / 6 push 被拒（锁被绕过）/ 7 环境失败 / 130,143 被中断
set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SELF_DIR/with-lock.py"
PY=/usr/bin/python3

LOCK_TIMEOUT="${DEEP_API_MERGE_LOCK_TIMEOUT:-1800}"
TEST_CMD="${DEEP_API_MERGE_TEST_CMD:-bunx vitest run}"
TSC_CMD="${DEEP_API_MERGE_TSC_CMD:-bunx tsc --noEmit}"

log() { printf '[deep-api-merge] %s\n' "$*"; }
die() { log "ERROR $1 $2"; exit "$1"; }
# JSON 字符串字面量转义（最小：\ 与 "）。bash 3.2 兼容，不引入 jq。
# 注意顺序：先转义 \\，再加 \"；否则 \" 引入的反斜杠会被二次转义。
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# 所有 git 调用：GIT_EDITOR 防编辑器挂死；GIT_TERMINAL_PROMPT=0 防凭据提示挂起持锁；
# 9>&- 防止子进程继承锁 fd 而延长锁寿命（尽力而为，不影响互斥正确性）
git_() { GIT_EDITOR=true GIT_TERMINAL_PROMPT=0 git "$@" 9>&-; }

# rebase 半成品清理。不写死 .git/rebase-merge：linked worktree 的 per-worktree 状态在
# <common>/worktrees/<name>/ 下。无 rebase 进行时 git 会报错，故抑制输出。
cleanup() {
  GIT_EDITOR=true git rebase --abort >/dev/null 2>&1
  # rebase 日志仅在失败时输出已 dump 到 stderr；无论成败都清理避免积累
  [ -n "${REBASE_LOG:-}" ] && rm -f "$REBASE_LOG" 2>/dev/null
}
on_signal() { exit "$1"; }
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# ---------------- Phase A: 前置检查（无锁） ----------------
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null)" || die 2 "不在 git 仓库内"
cd "$TOPLEVEL" || die 7 "无法进入工作树根 $TOPLEVEL"

COMMON="$(git rev-parse --path-format=absolute --git-common-dir)" \
  || die 7 "无法解析 git-common-dir"
LOCK="$COMMON/deep-api-merge.lock"
DIAG="$COMMON/deep-api-merge.owner.json"

git rev-parse --verify -q refs/remotes/origin/main >/dev/null \
  || die 2 "refs/remotes/origin/main 不可解析，先跑 git fetch origin"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] && die 2 "当前分支是 main，合并必须在 feature worktree 内发起"
[ "$BRANCH" = "HEAD" ] && die 2 "detached HEAD，合并必须在具名分支的 worktree 内发起"

[ -z "$(git status --porcelain)" ] \
  || die 2 "工作树不干净（含未跟踪文件），先提交或清理"

[ -d "$TOPLEVEL/node_modules" ] || die 2 "根 node_modules 缺失，先 bun install"

[ "$(git rev-list --count refs/remotes/origin/main..HEAD)" -gt 0 ] \
  || die 2 "相对本地 origin/main 无提交，无需合并"

# fd 9 探测：禁用 ( : 9>&9 )——实测它在 fd 9 空闲时也返回成功，会永远误判占用
[ -e /dev/fd/9 ] && die 2 "fd 9 已被占用；本脚本需要 fd 9，请从干净环境（新 shell）调用"

# ---------------- Phase B: 临界区（持锁） ----------------
exec 9<>"$LOCK" || die 7 "无法打开锁文件 $LOCK"
"$PY" "$HELPER" 9 "$LOCK_TIMEOUT" "$DIAG"
LOCK_RC=$?
[ "$LOCK_RC" -eq 3 ] && exit 3
[ "$LOCK_RC" -eq 0 ] || die 7 "with-lock.py 异常退出 rc=$LOCK_RC"

STARTED_EPOCH="$(date +%s)"                       # epoch 供耗时计算
STARTED_AT="$(date +%Y-%m-%dT%H:%M:%S%z)"         # 人读；注意 +0800 无冒号，
                                                  # Python 3.9 的 fromisoformat 解析不了，
                                                  # 故耗时一律用 startedAtEpoch
# 诊断写独立文件：锁文件本身永不写入/rename/删除（rename 换 inode 会使 flock 失效）
write_diag() {
  printf '{"pid":%s,"host":"%s","branch":"%s","worktree":"%s","phase":"%s","startedAt":"%s","startedAtEpoch":%s}\n' \
    "$$" "$(json_escape "$(hostname)")" "$(json_escape "$BRANCH")" \
    "$(json_escape "$TOPLEVEL")" "$(json_escape "$1")" \
    "$(json_escape "$STARTED_AT")" "$STARTED_EPOCH" > "$DIAG.tmp"
  mv -f "$DIAG.tmp" "$DIAG"
}
step() { write_diag "$1"; log "PHASE $1"; }

log "ACQUIRED branch=$BRANCH pid=$$"

step fetch
git_ fetch origin || die 7 "git fetch 失败"

step rebase
REBASE_LOG="$DIAG.rebase.log"
git_ rebase origin/main >"$REBASE_LOG" 2>&1
if [ $? -ne 0 ]; then
  CONFLICTS="$(git diff --name-only --diff-filter=U)"
  GIT_EDITOR=true git rebase --abort >/dev/null 2>&1
  if [ -n "$CONFLICTS" ]; then
    log "ERROR 4 rebase 冲突（已 abort，锁即将释放）"
    printf '%s\n' "$CONFLICTS" | sed 's/^/  conflict: /'
    exit 4
  fi
  log "ERROR 7 rebase 失败（非冲突）"
  sed 's/^/  /' "$REBASE_LOG" >&2
  exit 7
fi

step test
bash -c "$TEST_CMD" 9>&-
[ $? -eq 0 ] || die 5 "测试失败：$TEST_CMD"

step tsc
bash -c "$TSC_CMD" 9>&-
[ $? -eq 0 ] || die 5 "类型检查失败：$TSC_CMD"

step push
PUSH_OUT="$(git_ push origin HEAD:refs/heads/main 2>&1)"
PUSH_RC=$?
if [ "$PUSH_RC" -ne 0 ]; then
  case "$PUSH_OUT" in
    *non-fast-forward*|*\[rejected\]*)
      log "ERROR 6 push 被拒：持锁期间有进程绕过脚本推送了 origin/main"
      log "  local  HEAD = $(git rev-parse HEAD)"
      log "  origin/main = $(git rev-parse refs/remotes/origin/main)"
      printf '%s\n' "$PUSH_OUT" | sed 's/^/  /'
      exit 6 ;;
    *)
      log "ERROR 7 push 失败（网络/凭据/远端不可达）"
      printf '%s\n' "$PUSH_OUT" | sed 's/^/  /'
      exit 7 ;;
  esac
fi
MERGED_SHA="$(git rev-parse HEAD)"

# 临界区到此结束：释放锁（内核关闭 fd 9）
exec 9>&-
log "MERGED $MERGED_SHA origin/main"

# ---------------- Phase C: 主目录跟随（无锁，非致命） ----------------
PRIMARY="$(dirname "$COMMON")"

if ! git worktree list --porcelain | grep -qFx "worktree $PRIMARY"; then
  log "WARN primary worktree 未出现在 worktree list（${PRIMARY}），跳过 Phase C"
  exit 0
fi

PB="$(git -C "$PRIMARY" rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$PB" != "main" ]; then
  log "WARN 主目录当前分支是 ${PB}（非 main），跳过 Phase C（否则会把 origin/main 合进无关分支）"
  exit 0
fi

if [ -n "$(git -C "$PRIMARY" status --porcelain)" ]; then
  log "WARN 主目录工作树不干净，跳过 Phase C"
  exit 0
fi

GIT_EDITOR=true GIT_TERMINAL_PROMPT=0 git -C "$PRIMARY" fetch origin >/dev/null 2>&1 \
  || { log "WARN 主目录 fetch 失败，跳过 Phase C"; exit 0; }

DIVERGED="$(git -C "$PRIMARY" rev-list --count refs/remotes/origin/main..main)"
if [ "$DIVERGED" -ne 0 ]; then
  log "WARN 主目录 main 有 $DIVERGED 个 origin/main 之外的本地提交；跳过 Phase C（不自动 merge/rebase/reset）"
  exit 0
fi

if GIT_EDITOR=true GIT_TERMINAL_PROMPT=0 git -C "$PRIMARY" merge --ff-only origin/main >/dev/null 2>&1; then
  log "PHASE C 主目录已快进到 origin/main"
else
  log "WARN 主目录 merge --ff-only 失败，跳过"
fi
exit 0
