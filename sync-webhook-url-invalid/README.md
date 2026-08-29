# a Sync webhook rejected as invalid, or never called at all

Documents are changing and the backend hears nothing about it. Sometimes there is a 54051 in the error logs, Invalid webhook URL, and sometimes there is nothing at all &mdash; because the URL can be perfect and still never be called. webhooks_from_rest_enabled is off unless somebody turned it on, and the changes it suppresses are exactly the ones your own server makes.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/sync-webhook-url-invalid/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_sync_webhook_audit.py
node node/twilio-sync-webhook-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_sync_webhook_audit.py
node --test node/twilio-sync-webhook-audit.test.mjs
```
