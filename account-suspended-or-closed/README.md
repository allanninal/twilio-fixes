# the account itself is suspended, so every send fails with 20005

Everything stops at once. Messages, calls, number purchases, Verify starts &mdash; all of them come back 403 with 20005: Account not active, and the queued backlog dies behind them with 30002. The Console still loads, your dashboard still draws, and the API still answers questions about the account. It just will not do anything for it any more.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/account-suspended-or-closed/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_account_status_audit.py
node node/twilio-account-status-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_account_status_audit.py
node --test node/twilio-account-status-audit.test.mjs
```
