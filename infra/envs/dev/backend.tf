terraform {
  backend "s3" {
    bucket         = "aletheia-tfstate"
    key            = "envs/dev/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "aletheia-tf-locks"
    encrypt        = true
  }
}
