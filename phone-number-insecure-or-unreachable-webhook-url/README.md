# number webhooks on http, a private address or a dev tunnel

Somebody wired a number to http:// eighteen months ago and it has worked ever since, which is the problem. Somebody else pointed one at the ngrok URL from their laptop to test an idea on a Friday. A third pointed one at 10.0.4.31, copied from a staging config. Nothing about any of these appears in the Debugger until the day it breaks, and the first one never will.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/phone-number-insecure-or-unreachable-webhook-url/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_webhook_url_audit.py
node node/twilio-webhook-url-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_webhook_url_audit.py
node --test node/twilio-webhook-url-audit.test.mjs
```
