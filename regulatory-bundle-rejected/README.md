# a rejected regulatory bundle blocks every number purchase

A number that was available yesterday cannot be bought today, and the API is saying something about regulatory requirements rather than about the number. Nothing changed in your code. Somebody on Twilio's regulatory team opened the bundle that proves who you are to that country's regulator, read the documents attached to it, and refused them. That happened days ago, in a resource nobody on your team has a reason to open.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/regulatory-bundle-rejected/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_bundle_rejection_audit.py
node node/twilio-bundle-rejection-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_bundle_rejection_audit.py
node --test node/twilio-bundle-rejection-audit.test.mjs
```
