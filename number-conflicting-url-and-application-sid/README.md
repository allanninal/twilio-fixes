# a number with an Application SID ignores its own voice_url

You changed voice_url on the number this morning. You changed it again in the console an hour later and watched the page save. Calls keep arriving at an endpoint you retired last spring. Nothing is broken and nothing is cached &mdash; voice_application_sid is set on that number, and while it is, the field you keep editing is not read at all.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/number-conflicting-url-and-application-sid/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_number_app_precedence_audit.py
node node/twilio-number-app-precedence-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_number_app_precedence_audit.py
node --test node/twilio-number-app-precedence-audit.test.mjs
```
