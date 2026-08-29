# a link shortening certificate expires and short links break

The short domain in your messages is yours: go.example.com, in your brand, with a certificate somebody uploaded eighteen months ago and a calendar reminder that went to an address that no longer exists. Twilio does not renew it for you. When it expires, every shortened link in every message stops resolving, and the messages themselves start coming back 30120 while the click-through report goes flat.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/link-shortening-cert-expiring/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_link_domain_cert_audit.py
node node/twilio-link-domain-cert-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_link_domain_cert_audit.py
node --test node/twilio-link-domain-cert-audit.test.mjs
```
