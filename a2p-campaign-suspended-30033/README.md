# a suspended campaign returns 30033 and the sends keep coming

The suspension email went to the account owner's address, which forwards to a distribution list nobody reads. The send worker knows nothing about it: it dequeues, it calls the API, it gets a Message back with status undelivered and error_code 30033, and it retries. Four days later somebody notices, and by then the only question that matters &mdash; when did this start, and what has the code been doing since &mdash; is answerable only from the Messages list.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/a2p-campaign-suspended-30033/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_a2p_campaign_suspension_report.py
node node/twilio-a2p-campaign-suspension-report.mjs
```

## Test it

```bash
pytest python/test_twilio_a2p_campaign_suspension_report.py
node --test node/twilio-a2p-campaign-suspension-report.test.mjs
```
