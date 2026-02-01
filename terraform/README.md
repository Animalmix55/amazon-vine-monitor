# Terraform: Email on corycherven.dev (AWS SES)

Adds **Amazon SES** for your existing domain `corycherven.dev` on AWS:

- **Domain verification** so you can send email as `*@corycherven.dev`
- **DKIM** (CNAME records) for better deliverability
- Optional: **inbound email** (MX → SES, store in S3)

**DNS:** The domain `corycherven.dev` is hosted in **Namecheap**. Terraform does not manage DNS there, so use `create_route53_records = false` and add the verification/DKIM records manually in the Namecheap dashboard (see below).

**Prerequisites**

- AWS CLI (or env) configured with credentials for your AWS account.

**Region**

SES is region-scoped. Use `us-east-1` for full SES features (e.g. moving out of sandbox). Set `aws_region` in a `.tfvars` or `terraform.tfvars` if needed.

---

## Quick start

Because the domain is in Namecheap, plan/apply with Route 53 records disabled (default):

```bash
cd terraform
terraform init
terraform plan -var="create_route53_records=false" -out=tfplan
terraform apply tfplan
```

**Variables** (optional; defaults shown)

| Variable | Default | Description |
|----------|---------|-------------|
| `domain` | `corycherven.dev` | Domain to add email for |
| `aws_region` | `us-east-1` | AWS region for SES |
| `create_route53_records` | `false` | Create verification/DKIM in Route 53; set `false` when DNS is in Namecheap (default) |
| `enable_email_receiving` | `false` | Add MX + S3 + receipt rule for inbound mail |

**Example: custom region**

```bash
terraform apply -var="aws_region=us-west-2"
```

**Example: enable receiving**

```bash
terraform apply -var="enable_email_receiving=true"
```

---

## After apply

1. **Verification**  
   SES will show the domain as “Pending” until the TXT record propagates (usually a few minutes). After that it becomes “Verified”.

2. **Sending**  
   You can send from any address `@corycherven.dev` (e.g. `notify@corycherven.dev`). If the account is still in **SES sandbox**, verify each recipient (or request production access).

3. **Vine monitor**  
   In `.env` you can use SES SMTP or the AWS SDK. For SMTP, create an SES SMTP user in the console (or via IAM) and set:
   - `SMTP_HOST=email-smtp.us-east-1.amazonaws.com`
   - `SMTP_USER=<SES SMTP username>`
   - `SMTP_PASS=<SES SMTP password>`
   - `NOTIFICATION_SENDER=notify@corycherven.dev` and `NOTIFICATION_RECEIVER=you@corycherven.dev`

---

## Adding DNS records in Namecheap

The domain is in **Namecheap**, so add these records in the Namecheap DNS dashboard (Domain List → Manage → Advanced DNS):

1. **Domain verification (TXT)**  
   - **Host:** `_amazonses`  
   - **Value:** (from Terraform output `verification_token`)  
   - **TTL:** 600 or Automatic  

2. **DKIM (3 CNAME records)**  
   For each token in Terraform output `dkim_tokens`, add:
   - **Host:** `<token>._domainkey` (e.g. `tfmc4u3inonmpx5zwy2hwgvrjxvsen7h._domainkey`)  
   - **Value:** `<token>.dkim.amazonses.com`  
   - **TTL:** 600 or Automatic  

After saving, wait a few minutes for DNS to propagate. SES will then show the domain as **Verified**.
