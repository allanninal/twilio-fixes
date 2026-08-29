# 20003 on a read key: dead credential or a real boundary

Every other note in this section opens by telling you to run its script with an API Key that has read access. This is the one you run when that key comes back 401 with a body whose code is 20003, and you have to decide, before changing anything, whether the credential is broken or whether it just met a wall it was always going to meet.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/read-credential-permission-denied/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_read_credential_check.py
node node/twilio-read-credential-check.mjs
```

## Test it

```bash
pytest python/test_twilio_read_credential_check.py
node --test node/twilio-read-credential-check.test.mjs
```
