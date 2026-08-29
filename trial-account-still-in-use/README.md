# a production integration is still running on a trial account

The integration works. It has worked for weeks, on the developer's phone and on the tester's phone, and every message arrived. Then it goes in front of real users and most of them get nothing at all, while the few that do get a message find it starts with the words Sent from your Twilio trial account. Nobody chose this. The account was made for a spike, the spike became the product, and no one step in that sequence was the moment to upgrade.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/trial-account-still-in-use/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_trial_account_audit.py
node node/twilio-trial-account-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_trial_account_audit.py
node --test node/twilio-trial-account-audit.test.mjs
```
