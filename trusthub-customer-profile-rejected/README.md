# one rejected Trust Hub profile fails brands and toll-free

Two people are debugging two problems. One is on the A2P brand, which came back with a code about business identity. The other is on a toll-free verification, rejected for reasons about the business name. They are not related in any dashboard, they are being worked in separate tickets, and they are the same failure: the Trust Hub Customer Profile both of them were built from was rejected, and every product that hangs off it is failing in its own vocabulary.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/trusthub-customer-profile-rejected/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_customer_profile_audit.py
node node/twilio-customer-profile-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_customer_profile_audit.py
node --test node/twilio-customer-profile-audit.test.mjs
```
