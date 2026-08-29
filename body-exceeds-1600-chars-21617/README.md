# error 21617: the rendered message body exceeds 1600 chars

The template is fine. It has been fine for a year. Then one customer with a long company name, three line items and a German address renders past sixteen hundred characters, Twilio refuses the request with 21617, and that customer never receives the message. Their Message SID is not in your logs because there is no Message SID: the send was rejected before a resource was created, so it appears nowhere in the Messages list at all.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/body-exceeds-1600-chars-21617/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_body_length_audit.py
node node/twilio-body-length-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_body_length_audit.py
node --test node/twilio-body-length-audit.test.mjs
```
