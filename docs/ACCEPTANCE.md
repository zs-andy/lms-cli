# User acceptance checklist

Use test accounts/content allowed by the institution. Do not paste credentials in issue reports.

## Install and authorization

- Install the npm tarball in a clean directory on macOS and Windows; `lms --help`, `lms doctor` work without the source checkout.
- Configure PolyU, open `lms auth login`, finish actual SSO/MFA and verify `lms auth status --live` reports both reads successful. No manual Cookie/secret input. Closing/cancelling login must not erase previously working sessions.
- Leave one MCP connection open, reauthorize, then query again in that same connection. No restart required. Locally log out one platform with `auth logout --platform ... --yes`: the other remains available; the logged-out one cannot return cached private results.

## General capability, not a timetable-only demo

1. “列出两平台的课程。”
2. “某门课程老师最近通知了什么？附原文链接。”
3. “帮我找到该课程的实验说明，说明提交要求。”
4. “解释某次作业的评分反馈。”
5. “这周的时间表是什么？把通知里的作业、考试和调课也算上。”
6. “把已确认安排保存成待办/日历，并导出 ICS。”

Check results against known source pages, not just a fluent answer. Course IDs and parameters must be correct. Narrow queries should avoid exhaustive file crawls. Unavailable permissions/partial API pages must remain visible. File formats outside upstream support should be reported honestly.

## Schedule correctness

- Homework announced only in a notice still appears even if Canvas assignment list is empty.
- A later correction changes one existing task's time, keeping stable ID, source history, completion and notes.
- A cancelled class is cancelled, not retained as mandatory; alternative/group-specific lab sessions are flagged until the user's group is known.
- “Week 5” without a validated term-week mapping is not fabricated. A date without a time is not guessed as 23:59. Timezones are correct in display and ICS import.
- Notifications older than the fast lookback/per-course limit and unread attachments are disclosed as coverage limits. Ask a narrower follow-up or explicitly request wider history when necessary.

## Failure and security behavior

- Network blocked, expired sessions, one unavailable platform, `limit=101`, and missing IDs produce actionable errors, not empty-success “nothing due.”
- A prompt injection inside a mock notice cannot cause credential access, shell commands, remote submissions, quiz attempts or message sending. Those operations are not in the reviewed tool list.
- Installed files contain no credentials, real student state, developer paths, `.env` or logs. Linux keychain-unavailable state fails closed.
- Check the authorization app UI and MFA popups on each target OS. Embedded login blocked by school policy is a compatibility limitation, not something to bypass.

Record the OS, package version, school platform/version, elapsed time and success/failure for these checks. CI/offline tests do not substitute for actual school SSO and final user acceptance. Daily automations and calendar subscriptions are intentionally not configured by installation.
