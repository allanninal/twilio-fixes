# no API keys exist, so the auth token is the credential

Every other note in this section tells you to run its script with an API Key that has read access rather than the account auth token. This is the one that explains why, and how to find out whether anything you run is still holding the token. Nothing is failing right now. That is the shape of the problem: it costs you nothing until the day you have to rotate, and then it costs you everything at once.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/auth-token-used-instead-of-api-key/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_credential_audit.py
node node/twilio-credential-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_credential_audit.py
node --test node/twilio-credential-audit.test.mjs
```
