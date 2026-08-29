# numbers still pinned to the 2008-08-01 API version

The delivery-failure dashboard has a bucket called unknown and it is a third of the chart. The code reads error_code off each message, the documentation says the field is there, and for messages from one particular number it is simply absent. That number was bought in 2014. It still carries api_version of 2008-08-01, and the 2008 schema does not have that field.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/pinned-old-api-version/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_api_version_audit.py
node node/twilio-api-version-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_api_version_audit.py
node --test node/twilio-api-version-audit.test.mjs
```
