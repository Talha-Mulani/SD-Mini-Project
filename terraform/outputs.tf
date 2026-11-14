output "mumbai_public_ip" {
  description = "Public IP address of the Mumbai GeoCache node"
  value       = aws_instance.mumbai_vm.public_ip
}

output "frankfurt_public_ip" {
  description = "Public IP address of the Frankfurt GeoCache node"
  value       = aws_instance.frankfurt_vm.public_ip
}

output "virginia_public_ip" {
  description = "Public IP address of the Virginia GeoCache node"
  value       = aws_instance.virginia_vm.public_ip
}

output "peer_configuration_json" {
  description = "Cross-region PEERS JSON for environment variable configuration"
  value = jsonencode({
    mumbai    = "http://${aws_instance.mumbai_vm.public_ip}:5001"
    frankfurt = "http://${aws_instance.frankfurt_vm.public_ip}:5002"
    virginia  = "http://${aws_instance.virginia_vm.public_ip}:5003"
  })
}
