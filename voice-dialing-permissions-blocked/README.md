# 21215: dialing permissions block a country you sell into

The integration has worked for a year. A customer in a new country signs up, the first call to them fails with 21215 Account not authorized to call this number, and every explanation you can think of is about the number. It is not about the number. Your account has an allowlist of countries it may dial, it was built from where you signed up, and nobody has looked at it since.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/voice-dialing-permissions-blocked/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_dialing_permissions_audit.py
node node/twilio-dialing-permissions-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_dialing_permissions_audit.py
node --test node/twilio-dialing-permissions-audit.test.mjs
```
