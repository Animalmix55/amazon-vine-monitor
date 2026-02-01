variable "domain" {
  description = "Domain to add email (SES) for, e.g. corycherven.dev"
  type        = string
  default     = "corycherven.dev"
}

variable "aws_region" {
  description = "AWS region for SES (e.g. us-east-1 for full SES features)"
  type        = string
  default     = "us-east-1"
}

variable "create_route53_records" {
  description = "Create Route 53 records for SES verification/DKIM. Default false: domain corycherven.dev is in Namecheap, so add records there manually."
  type        = bool
  default     = false
}

variable "enable_email_receiving" {
  description = "Add MX record to receive email at this domain via SES"
  type        = bool
  default     = false
}
