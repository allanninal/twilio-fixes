# twilio cannot open a TCP connection to your webhook (11205)

You have the URL open in a browser tab and it works. Curl works. The health check is green. And the Twilio Debugger is filling with 11205 HTTP connection failure for that exact URL, while your access log has no entry for it at all &mdash; not a 500, not a 404, nothing. The request never arrived, because the connection was never opened.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/webhook-connection-timeout-11205/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_webhook_timeout_audit.py
node node/twilio-webhook-timeout-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_webhook_timeout_audit.py
node --test node/twilio-webhook-timeout-audit.test.mjs
```
