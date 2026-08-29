# a Verify Service issuing four-digit codes to production

Nothing is failing. Codes arrive, users type them in, verifications approve, and conversion rate is flat and healthy. The only thing to notice is one integer in the Service resource, set during the first week of the integration when a four-digit code was faster to read off a phone during QA &mdash; and that has been the length of every code you have sent since.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/verify-code-length-too-short/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_verify_code_length_audit.py
node node/twilio-verify-code-length-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_verify_code_length_audit.py
node --test node/twilio-verify-code-length-audit.test.mjs
```
