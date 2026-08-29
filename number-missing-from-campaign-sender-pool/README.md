# a 10DLC number outside the sender pool is never registered

Somebody bought a second number for the marketing send, because the support number was busy. The brand is APPROVED, the campaign is VERIFIED, so the number is registered &mdash; that is how everyone on the team understood it. Except registration does not attach to an account or to a brand. It attaches to numbers, one at a time, through the sender pool of the Messaging Service that carries the campaign, and this number was never added to one.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/number-missing-from-campaign-sender-pool/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_10dlc_sender_pool_gap.py
node node/twilio-10dlc-sender-pool-gap.mjs
```

## Test it

```bash
pytest python/test_twilio_10dlc_sender_pool_gap.py
node --test node/twilio-10dlc-sender-pool-gap.test.mjs
```
