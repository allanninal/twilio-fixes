# OTP codes sent without the do-not-share warning line

Somebody phoned your customer, said they were from your support team, told them there was a suspicious login and that a code was on its way to confirm it was really them. The code arrived, on time, from your number, saying nothing except what the code was. The customer read it out. Nothing in that message gave them a reason not to.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/verify-do-not-share-warning-off/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_verify_warning_audit.py
node node/twilio-verify-warning-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_verify_warning_audit.py
node --test node/twilio-verify-warning-audit.test.mjs
```
