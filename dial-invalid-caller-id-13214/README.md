# Dial rejected with 13214 on a passed-through caller ID

Call forwarding works. It has worked all week. Then a handful of calls fail, and they fail without a pattern anyone can see &mdash; not one number, not one hour, not one destination. What they have in common is invisible from the outside: the inbound leg arrived carrying a caller ID the terminating carrier will not accept, your &lt;Dial&gt; passed it through unchanged, and Twilio logged 13214 Dial: Invalid callerId value against a call nobody was watching.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/dial-invalid-caller-id-13214/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_dial_caller_id_audit.py
node node/twilio-dial-caller-id-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_dial_caller_id_audit.py
node --test node/twilio-dial-caller-id-audit.test.mjs
```
