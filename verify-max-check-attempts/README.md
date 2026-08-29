# 60202: a verification that burned all five check attempts

The support ticket says the code does not work. It does work; the user is holding the right one. Somewhere between the keypad and your server the five checks that verification was allowed have already been spent, the verification has moved to max_attempts_reached, and every further attempt returns 60202 until it expires. The screen offers a Verify button that can no longer do anything.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/verify-max-check-attempts/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_verify_check_attempts_audit.py
node node/twilio-verify-check-attempts-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_verify_check_attempts_audit.py
node --test node/twilio-verify-check-attempts-audit.test.mjs
```
