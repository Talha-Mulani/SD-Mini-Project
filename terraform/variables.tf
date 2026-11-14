variable "region_mumbai" {
  description = "AWS Region for Mumbai node"
  type        = string
  default     = "ap-south-1"
}

variable "region_frankfurt" {
  description = "AWS Region for Frankfurt node"
  type        = string
  default     = "eu-central-1"
}

variable "region_virginia" {
  description = "AWS Region for Virginia node"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 Instance type for GeoCache regional VMs"
  type        = string
  default     = "t4g.medium" # ARM-based Graviton2: cost-efficient, high network throughput
}

# Standard Ubuntu 24.04 LTS AMIs (ARM64)
variable "ami_mumbai" {
  type    = string
  default = "ami-053b12d3152c0cc71"
}

variable "ami_frankfurt" {
  type    = string
  default = "ami-065ab11fbd3d0323d"
}

variable "ami_virginia" {
  type    = string
  default = "ami-080e1f13689e07408"
}

variable "admin_cidr" {
  description = "CIDR block permitted for SSH administration"
  type        = string
  default     = "0.0.0.0/0"
}

variable "inter_region_secret" {
  description = "HMAC shared secret for inter-region authentication"
  type        = string
  sensitive   = true
  default     = "geocache-prod-cluster-hmac-shared-secret-key-389172"
}
