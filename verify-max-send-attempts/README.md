# 60203: a resend button with no cooldown burns five sends

SMS took eleven seconds to arrive, so the user pressed Resend. Then again. Then once more, because the first three had not landed yet either &mdash; they had, all four of them, in a burst, several seconds after the fourth press. Now 60203 comes back, the button does nothing, and you have paid for four messages to deliver one code.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/verify-max-send-attempts/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_verify_send_attempts_audit.py
node node/twilio-verify-send-attempts-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_verify_send_attempts_audit.py
node --test node/twilio-verify-send-attempts-audit.test.mjs
```
