# Terraform Multi-Region Active-Active GeoCache Infrastructure
# Deploys 3 Cloud Regions:
# - Region 1: ap-south-1 (Mumbai)
# - Region 2: eu-central-1 (Frankfurt)
# - Region 3: us-east-1 (Virginia)
# Includes VPCs, EC2 instances, CloudWatch Agent IAM Roles, and Route 53 Latency Routing.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Provider configurations per region
provider "aws" {
  alias  = "mumbai"
  region = var.region_mumbai
}

provider "aws" {
  alias  = "frankfurt"
  region = var.region_frankfurt
}

provider "aws" {
  alias  = "virginia"
  region = var.region_virginia
}

# ----------------- IAM ROLE FOR CLOUDWATCH LOGS & METRICS -----------------

resource "aws_iam_role" "geocache_node" {
  name = "geocache-node-cloudwatch-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  role       = aws_iam_role.geocache_node.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.geocache_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "geocache_profile" {
  name = "geocache-instance-profile"
  role = aws_iam_role.geocache_node.name
}

# ----------------- REGION 1: MUMBAI (ap-south-1) -----------------

resource "aws_vpc" "mumbai_vpc" {
  provider             = aws.mumbai
  cidr_block           = "10.10.0.0/16"
  enable_dns_hostnames = true
  tags = { Name = "geocache-vpc-mumbai" }
}

resource "aws_subnet" "mumbai_subnet" {
  provider                = aws.mumbai
  vpc_id                  = aws_vpc.mumbai_vpc.id
  cidr_block              = "10.10.1.0/24"
  map_public_ip_on_launch = true
  tags = { Name = "geocache-subnet-mumbai" }
}

resource "aws_internet_gateway" "mumbai_igw" {
  provider = aws.mumbai
  vpc_id   = aws_vpc.mumbai_vpc.id
}

resource "aws_route_table" "mumbai_rt" {
  provider = aws.mumbai
  vpc_id   = aws_vpc.mumbai_vpc.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.mumbai_igw.id
  }
}

resource "aws_route_table_association" "mumbai_rta" {
  provider       = aws.mumbai
  subnet_id      = aws_subnet.mumbai_subnet.id
  route_table_id = aws_route_table.mumbai_rt.id
}

resource "aws_security_group" "mumbai_sg" {
  provider = aws.mumbai
  vpc_id   = aws_vpc.mumbai_vpc.id
  name     = "geocache-sg-mumbai"

  ingress {
    from_port   = 5001
    to_port     = 5001
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Regional GeoCache API & Replication"
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
    description = "SSH Admin"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "mumbai_vm" {
  provider             = aws.mumbai
  ami                  = var.ami_mumbai
  instance_type        = var.instance_type
  subnet_id            = aws_subnet.mumbai_subnet.id
  vpc_security_group_ids = [aws_security_group.mumbai_sg.id]
  iam_instance_profile = aws_iam_instance_profile.geocache_profile.name

  user_data = templatefile("${path.module}/userdata.sh", {
    REGION                = "mumbai"
    PORT                  = "5001"
    INTER_REGION_SECRET   = var.inter_region_secret
    CLOUDWATCH_NAMESPACE  = "GlobalCart/GeoCache"
  })

  tags = {
    Name        = "geocache-node-mumbai"
    Environment = "production"
    Region      = "mumbai"
  }
}

# ----------------- REGION 2: FRANKFURT (eu-central-1) -----------------

resource "aws_vpc" "frankfurt_vpc" {
  provider             = aws.frankfurt
  cidr_block           = "10.20.0.0/16"
  enable_dns_hostnames = true
  tags = { Name = "geocache-vpc-frankfurt" }
}

resource "aws_subnet" "frankfurt_subnet" {
  provider                = aws.frankfurt
  vpc_id                  = aws_vpc.frankfurt_vpc.id
  cidr_block              = "10.20.1.0/24"
  map_public_ip_on_launch = true
  tags = { Name = "geocache-subnet-frankfurt" }
}

resource "aws_internet_gateway" "frankfurt_igw" {
  provider = aws.frankfurt
  vpc_id   = aws_vpc.frankfurt_vpc.id
}

resource "aws_route_table" "frankfurt_rt" {
  provider = aws.frankfurt
  vpc_id   = aws_vpc.frankfurt_vpc.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.frankfurt_igw.id
  }
}

resource "aws_route_table_association" "frankfurt_rta" {
  provider       = aws.frankfurt
  subnet_id      = aws_subnet.frankfurt_subnet.id
  route_table_id = aws_route_table.frankfurt_rt.id
}

resource "aws_security_group" "frankfurt_sg" {
  provider = aws.frankfurt
  vpc_id   = aws_vpc.frankfurt_vpc.id
  name     = "geocache-sg-frankfurt"

  ingress {
    from_port   = 5002
    to_port     = 5002
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Regional GeoCache API & Replication"
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
    description = "SSH Admin"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "frankfurt_vm" {
  provider             = aws.frankfurt
  ami                  = var.ami_frankfurt
  instance_type        = var.instance_type
  subnet_id            = aws_subnet.frankfurt_subnet.id
  vpc_security_group_ids = [aws_security_group.frankfurt_sg.id]
  iam_instance_profile = aws_iam_instance_profile.geocache_profile.name

  user_data = templatefile("${path.module}/userdata.sh", {
    REGION                = "frankfurt"
    PORT                  = "5002"
    INTER_REGION_SECRET   = var.inter_region_secret
    CLOUDWATCH_NAMESPACE  = "GlobalCart/GeoCache"
  })

  tags = {
    Name        = "geocache-node-frankfurt"
    Environment = "production"
    Region      = "frankfurt"
  }
}

# ----------------- REGION 3: VIRGINIA (us-east-1) -----------------

resource "aws_vpc" "virginia_vpc" {
  provider             = aws.virginia
  cidr_block           = "10.30.0.0/16"
  enable_dns_hostnames = true
  tags = { Name = "geocache-vpc-virginia" }
}

resource "aws_subnet" "virginia_subnet" {
  provider                = aws.virginia
  vpc_id                  = aws_vpc.virginia_vpc.id
  cidr_block              = "10.30.1.0/24"
  map_public_ip_on_launch = true
  tags = { Name = "geocache-subnet-virginia" }
}

resource "aws_internet_gateway" "virginia_igw" {
  provider = aws.virginia
  vpc_id   = aws_vpc.virginia_vpc.id
}

resource "aws_route_table" "virginia_rt" {
  provider = aws.virginia
  vpc_id   = aws_vpc.virginia_vpc.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.virginia_igw.id
  }
}

resource "aws_route_table_association" "virginia_rta" {
  provider       = aws.virginia
  subnet_id      = aws_subnet.virginia_subnet.id
  route_table_id = aws_route_table.virginia_rt.id
}

resource "aws_security_group" "virginia_sg" {
  provider = aws.virginia
  vpc_id   = aws_vpc.virginia_vpc.id
  name     = "geocache-sg-virginia"

  ingress {
    from_port   = 5003
    to_port     = 5003
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Regional GeoCache API & Replication"
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
    description = "SSH Admin"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "virginia_vm" {
  provider             = aws.virginia
  ami                  = var.ami_virginia
  instance_type        = var.instance_type
  subnet_id            = aws_subnet.virginia_subnet.id
  vpc_security_group_ids = [aws_security_group.virginia_sg.id]
  iam_instance_profile = aws_iam_instance_profile.geocache_profile.name

  user_data = templatefile("${path.module}/userdata.sh", {
    REGION                = "virginia"
    PORT                  = "5003"
    INTER_REGION_SECRET   = var.inter_region_secret
    CLOUDWATCH_NAMESPACE  = "GlobalCart/GeoCache"
  })

  tags = {
    Name        = "geocache-node-virginia"
    Environment = "production"
    Region      = "virginia"
  }
}
