# a rejected WhatsApp content template blocks every send

The template was approved in March and the notifications have gone out every day since. This morning they stopped. Nobody changed the code, nobody changed the template, and whatsapp.status now reads paused &mdash; Meta paused it on user feedback, and every send that uses it comes back 63041 until it comes back on its own.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/whatsapp-content-template-rejected/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_whatsapp_template_audit.py
node node/twilio-whatsapp-template-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_whatsapp_template_audit.py
node --test node/twilio-whatsapp-template-audit.test.mjs
```
