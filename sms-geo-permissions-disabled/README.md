# SMS Geo Permissions are off for the destination country

The German customers onboarded this morning have received nothing. The same code, the same template and the same Messaging Service deliver perfectly at home. Every one of the failed messages carries 21408, and there is no setting you can read through the API to confirm why &mdash; SMS Geo Permissions is a console-only switch, in both directions.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/sms-geo-permissions-disabled/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_geo_permission_audit.py
node node/twilio-geo-permission-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_geo_permission_audit.py
node --test node/twilio-geo-permission-audit.test.mjs
```
