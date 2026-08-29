# 13224: Twilio refuses the number your Dial verb asked for

The call connects, your TwiML runs, the &lt;Dial&gt; produces silence, and then the call carries on to the action URL as though the leg had simply not been answered. Nobody rang. 13224 Dial: Twilio does not support calling this number or the number is invalid is sitting in the Debugger, and about half the time it is not in the error level at all.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/dial-number-unsupported-or-invalid-13224/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_dial_target_audit.py
node node/twilio-dial-target-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_dial_target_audit.py
node --test node/twilio-dial-target-audit.test.mjs
```
