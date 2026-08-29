# an a2p campaign parked at IN_PROGRESS is not a live campaign

Registration was submitted, the console went quiet, and three weeks later the launch shipped on the assumption that quiet meant done. It did not. campaign_status still reads IN_PROGRESS, campaign_id is still null, and every US message is coming back 30034. Nothing is broken. It simply was never approved.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/a2p-campaign-stuck-in-progress/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_a2p_campaign_wait_audit.py
node node/twilio-a2p-campaign-wait-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_a2p_campaign_wait_audit.py
node --test node/twilio-a2p-campaign-wait-audit.test.mjs
```
