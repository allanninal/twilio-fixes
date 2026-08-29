# outbound messaging is off, so every send fails with 30037

One tenant stopped receiving messages. Not slowly, not partially &mdash; every send from that subaccount comes back with error_code=30037, &ldquo;outbound message not allowed&rdquo;, while the other nineteen tenants on the same code, the same numbers and the same deploy are entirely unaffected. Nothing changed on your side, which is exactly what makes it hard to look for.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/outbound-messaging-disabled-30037/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_outbound_disabled_audit.py
node node/twilio-outbound-disabled-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_outbound_disabled_audit.py
node --test node/twilio-outbound-disabled-audit.test.mjs
```
