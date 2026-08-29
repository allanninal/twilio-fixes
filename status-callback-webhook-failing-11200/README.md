# status callback failures with 11200 leave delivery state blind

Support says the customer never got the text. Your dashboard agrees: the row still reads queued, hours later. Then you open the Twilio Console, paste the Message SID, and it says delivered &mdash; forty seconds after you sent it. Nothing was lost. Twilio tried to tell you, your endpoint returned something other than a 2xx, and the update went in the bin along with every other one that day.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/status-callback-webhook-failing-11200/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_status_callback_audit.py
node node/twilio-status-callback-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_status_callback_audit.py
node --test node/twilio-status-callback-audit.test.mjs
```
