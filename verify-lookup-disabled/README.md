# Verify runs with lookup_enabled false, so landlines are billed

Somebody switched on skip SMS to landlines months ago, the setting is still there in the console, and Verify has been sending SMS into landlines the entire time. The guard needs a Lookup on each verification start to know what a landline is, and Lookup is off &mdash; so the switch is set, saved, displayed back to you, and doing nothing at all.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/verify-lookup-disabled/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_verify_lookup_audit.py
node node/twilio-verify-lookup-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_verify_lookup_audit.py
node --test node/twilio-verify-lookup-audit.test.mjs
```
