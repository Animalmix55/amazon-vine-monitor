output "domain_identity_arn" {
  description = "SES domain identity ARN"
  value       = aws_ses_domain_identity.main.arn
}

output "domain_identity_verification_status" {
  description = "SES domain verification status (PendingSuccess until DNS propagates)"
  value       = var.create_route53_records ? aws_ses_domain_identity_verification.main[0].id : "N/A (add DNS records manually)"
}

output "dkim_tokens" {
  description = "DKIM CNAME tokens (add these if create_route53_records = false)"
  value       = aws_ses_domain_dkim.main.dkim_tokens
}

output "verification_token" {
  description = "SES domain verification TXT record value (add _amazonses.<domain> if create_route53_records = false)"
  value       = aws_ses_domain_identity.main.verification_token
  sensitive   = false
}

output "inbound_bucket_name" {
  description = "S3 bucket for inbound mail (when enable_email_receiving = true)"
  value       = var.enable_email_receiving ? aws_s3_bucket.mail[0].id : null
}
