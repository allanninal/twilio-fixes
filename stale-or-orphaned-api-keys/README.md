# years-old API keys are still live with nobody owning them

There are eleven keys on the account. Four have names. One of the unnamed ones was created in March 2023 by a contractor whose email address stopped working two years ago, and nobody can say what it authenticates. It has never expired, because Twilio keys do not. It has no last-used timestamp, because that field does not exist. And deleting it to find out will also invalidate every Access Token it ever signed.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/stale-or-orphaned-api-keys/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_api_key_audit.py
node node/twilio-api-key-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_api_key_audit.py
node --test node/twilio-api-key-audit.test.mjs
```
