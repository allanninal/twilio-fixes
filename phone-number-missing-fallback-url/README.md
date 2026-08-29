# a number with no fallback URL drops the call when yours 500s

Your webhook was down for ninety seconds during a deploy. Twilio requested it, got a 502, logged an 11200 and hung up on whoever was calling. There was a mitigation for exactly this, it costs one field on the number, and it is empty on every number you own.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/phone-number-missing-fallback-url/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_fallback_audit.py
node node/twilio-fallback-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_fallback_audit.py
node --test node/twilio-fallback-audit.test.mjs
```
