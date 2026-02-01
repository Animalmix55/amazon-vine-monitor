provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------
# Route 53 zone (optional: domain corycherven.dev is in Namecheap; set
# create_route53_records = true only if you move DNS to Route 53)
# ---------------------------------------------------------------------------
data "aws_route53_zone" "main" {
  count        = var.create_route53_records ? 1 : 0
  name         = "${var.domain}."
  private_zone = false
}

# ---------------------------------------------------------------------------
# SES domain identity and verification
# ---------------------------------------------------------------------------
resource "aws_ses_domain_identity" "main" {
  domain = var.domain
}

resource "aws_ses_domain_identity_verification" "main" {
  count  = var.create_route53_records ? 1 : 0
  domain = aws_ses_domain_identity.main.id

  depends_on = [aws_route53_record.ses_verification]
}

resource "aws_route53_record" "ses_verification" {
  count   = var.create_route53_records ? 1 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "_amazonses.${var.domain}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.main.verification_token]
}

# ---------------------------------------------------------------------------
# DKIM (recommended for deliverability)
# ---------------------------------------------------------------------------
resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

resource "aws_route53_record" "dkim" {
  count   = var.create_route53_records ? 3 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = "${aws_ses_domain_dkim.main.dkim_tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.main.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# ---------------------------------------------------------------------------
# Optional: receive email at this domain (SES receipt rule set + S3)
# ---------------------------------------------------------------------------
data "aws_caller_identity" "current" {}

resource "aws_ses_receipt_rule_set" "main" {
  count         = var.enable_email_receiving ? 1 : 0
  rule_set_name = "${replace(var.domain, ".", "-")}-inbound"
}

resource "aws_ses_active_receipt_rule_set" "inbound" {
  count         = var.enable_email_receiving ? 1 : 0
  rule_set_name = aws_ses_receipt_rule_set.main[0].rule_set_name
}

resource "aws_s3_bucket" "mail" {
  count  = var.enable_email_receiving ? 1 : 0
  bucket = "ses-inbound-${replace(var.domain, ".", "-")}-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_lifecycle_configuration" "mail" {
  count  = var.enable_email_receiving ? 1 : 0
  bucket = aws_s3_bucket.mail[0].id

  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = 30
    }
  }
}

resource "aws_s3_bucket_policy" "mail" {
  count  = var.enable_email_receiving ? 1 : 0
  bucket = aws_s3_bucket.mail[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowSESPuts"
        Effect = "Allow"
        Principal = { Service = "ses.amazonaws.com" }
        Action = "s3:PutObject"
        Resource = "${aws_s3_bucket.mail[0].arn}/*"
        Condition = {
          StringEquals = { "aws:Referer" = data.aws_caller_identity.current.account_id }
        }
      }
    ]
  })
}

resource "aws_ses_receipt_rule" "store" {
  count         = var.enable_email_receiving ? 1 : 0
  name          = "store-${var.domain}"
  rule_set_name = aws_ses_receipt_rule_set.main[0].rule_set_name
  enabled       = true
  scan_enabled  = true
  recipients    = [var.domain]

  s3_action {
    bucket_name       = aws_s3_bucket.mail[0].id
    object_key_prefix = "inbound/"
    position          = 1
  }
}

# MX record for receiving (SES inbound)
resource "aws_route53_record" "mx" {
  count   = var.create_route53_records && var.enable_email_receiving ? 1 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain
  type    = "MX"
  ttl     = 600
  records = [
    "10 inbound-smtp.${var.aws_region}.amazonaws.com"
  ]
}
