# messages stay queued or accepted and never reach a final state

The send succeeded four hours ago. status is still queued. error_code is null, date_sent is null, and the status callback has never fired because nothing has happened to report. Nobody has been paged, because nothing has failed yet &mdash; and in six hours these will start failing with 30001 or expiring with 30036, long after the passcode they carry stopped being useful.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/messages-stuck-queued-or-accepted/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_stuck_messages_audit.py
node node/twilio-stuck-messages-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_stuck_messages_audit.py
node --test node/twilio-stuck-messages-audit.test.mjs
```
