# Verify conversion collapses in one country: SMS pumping

The Verify bill for the month is five times last month's. Nothing is failing: no 4xx, no error code, no delivery problem, no support tickets. The sends are being accepted, delivered and charged exactly as designed. The only thing that changed is that in one country almost nobody types the code in any more &mdash; and that single number is the difference between a growth spurt and somebody quietly farming your signup form.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/verify-conversion-rate-collapse/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_verify_conversion_audit.py
node node/twilio-verify-conversion-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_verify_conversion_audit.py
node --test node/twilio-verify-conversion-audit.test.mjs
```
