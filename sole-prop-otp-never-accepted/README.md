# a Sole Proprietor brand blocked by an OTP nobody answered

The registration went in. Somewhere a phone buzzed with a passcode and a message about a business the owner had half forgotten agreeing to. They did not reply, or they replied on Thursday to a code that expired on Wednesday. identity_status is still SELF_DECLARED, the campaign underneath cannot register, and every US message is coming back 30034 for a reason nobody in your building can see.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/sole-prop-otp-never-accepted/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_sole_prop_otp_audit.py
node node/twilio-sole-prop-otp-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_sole_prop_otp_audit.py
node --test node/twilio-sole-prop-otp-audit.test.mjs
```
